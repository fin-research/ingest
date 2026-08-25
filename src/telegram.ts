import { fetchCentralBankPolicyNews, readTextBounded, type ArticleMetadata, type Fetcher } from "./article";

const MAX_TELEGRAM_RESPONSE_BYTES = 64 * 1024;
const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export interface TelegramCollectionSummary {
  matched: number;
  existing: number;
  sent: number;
}

export interface TelegramDeliveryRepository {
  findDeliveredIds(ids: string[]): Promise<Set<string>>;
  markDelivered(article: ArticleMetadata, sentAt: string, messageId: number): Promise<void>;
}

export interface TelegramNotifier {
  send(article: ArticleMetadata): Promise<number>;
}

interface TelegramCollectorDependencies {
  apiBaseUrl: string;
  repository: TelegramDeliveryRepository;
  getNotifier: () => Promise<TelegramNotifier>;
  fetcher?: Fetcher;
}

export async function collectCentralBankNotifications(
  env: Env,
  sentAt: string,
): Promise<TelegramCollectionSummary> {
  return await runCentralBankNotificationCollection(
    {
      apiBaseUrl: env.ARTICLE_API_BASE_URL,
      repository: new D1TelegramDeliveryRepository(env.DB),
      getNotifier: async () => {
        let botToken: string;
        let userId: string;
        try {
          [botToken, userId] = await Promise.all([
            env.TELEGRAM_BOT_TOKEN.get(),
            env.TELEGRAM_USER_ID.get(),
          ]);
        } catch {
          throw new Error("Telegram credentials are unavailable from Secrets Store");
        }
        return new TelegramBotNotifier(botToken, userId);
      },
    },
    sentAt,
  );
}

export async function runCentralBankNotificationCollection(
  dependencies: TelegramCollectorDependencies,
  sentAt: string,
): Promise<TelegramCollectionSummary> {
  const articles = await fetchCentralBankPolicyNews(
    dependencies.apiBaseUrl,
    dependencies.fetcher,
  );
  if (articles.length === 0) return { matched: 0, existing: 0, sent: 0 };

  const deliveredIds = await dependencies.repository.findDeliveredIds(
    articles.map((article) => article.id),
  );
  const pending = articles.filter((article) => !deliveredIds.has(article.id));
  if (pending.length === 0) {
    return { matched: articles.length, existing: articles.length, sent: 0 };
  }

  const notifier = await dependencies.getNotifier();
  let sent = 0;
  for (const article of pending) {
    let messageId: number;
    try {
      messageId = await notifier.send(article);
    } catch (error) {
      throw new Error(
        `Telegram notification failed for article ${article.id}: ${publicErrorMessage(error)}`,
      );
    }
    await dependencies.repository.markDelivered(article, sentAt, messageId);
    sent += 1;
  }

  return { matched: articles.length, existing: deliveredIds.size, sent };
}

export class D1TelegramDeliveryRepository implements TelegramDeliveryRepository {
  constructor(private readonly database: D1Database) {}

  async findDeliveredIds(ids: string[]): Promise<Set<string>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return new Set();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const result = await this.database
      .prepare(`SELECT article_id FROM telegram_delivery WHERE article_id IN (${placeholders})`)
      .bind(...uniqueIds)
      .all<{ article_id: string }>();
    return new Set(result.results.map((row) => row.article_id));
  }

  async markDelivered(article: ArticleMetadata, sentAt: string, messageId: number): Promise<void> {
    await this.database
      .prepare(`
        INSERT INTO telegram_delivery (
          article_id, title, published_at, sent_at, telegram_message_id
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(article_id) DO NOTHING
      `)
      .bind(article.id, article.title, article.publishedAt, sentAt, messageId)
      .run();
  }
}

export class TelegramBotNotifier implements TelegramNotifier {
  private readonly botToken: string;
  private readonly userId: string;

  constructor(
    botToken: string,
    userId: string,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.botToken = requireTelegramBotToken(botToken);
    this.userId = requireTelegramUserId(userId);
  }

  async send(article: ArticleMetadata): Promise<number> {
    const endpoint = new URL(`https://api.telegram.org/bot${this.botToken}/sendMessage`);
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.userId,
          text: formatCentralBankNotification(article),
        }),
        signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `Telegram sendMessage request failed: ${redactTelegramFetchError(error, this.botToken)}`,
      );
    }

    const payload = await readTelegramResponse(response);
    if (!response.ok || !payload.ok) {
      const errorCode = payload.errorCode ? `, code ${payload.errorCode}` : "";
      const description = payload.description ? `: ${payload.description}` : "";
      throw new Error(
        `Telegram sendMessage failed with HTTP ${response.status}${errorCode}${description}`,
      );
    }
    if (!payload.result || !Number.isSafeInteger(payload.result.message_id)) {
      throw new Error("Telegram sendMessage response is missing message_id");
    }
    return payload.result.message_id;
  }
}

export function formatCentralBankNotification(article: ArticleMetadata): string {
  return `${article.title}\n发布时间：${formatShanghaiDateTime(article.publishedAt)}`;
}

interface TelegramResponse {
  ok: boolean;
  result?: { message_id: number };
  errorCode?: number;
  description?: string;
}

async function readTelegramResponse(response: Response): Promise<TelegramResponse> {
  const text = await readTextBounded(response, MAX_TELEGRAM_RESPONSE_BYTES, "Telegram response");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Telegram sendMessage response is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Telegram sendMessage response must be an object");
  }
  const row = value as Record<string, unknown>;
  const result = row.result;
  if (typeof row.ok !== "boolean") {
    throw new Error("Telegram sendMessage response is missing ok");
  }
  const errorCode = row.error_code;
  const description = row.description;
  const errorFields = {
    ...(typeof errorCode === "number" && Number.isSafeInteger(errorCode)
      ? { errorCode }
      : {}),
    ...(typeof description === "string" && description.trim()
      ? { description: description.trim().slice(0, 500) }
      : {}),
  };
  if (result === undefined) return { ok: row.ok, ...errorFields };
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Telegram sendMessage result must be an object");
  }
  const messageId = (result as Record<string, unknown>).message_id;
  return {
    ok: row.ok,
    ...errorFields,
    ...(typeof messageId === "number" ? { result: { message_id: messageId } } : {}),
  };
}

function requireCredential(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Telegram ${name} is empty`);
  return normalized;
}

function requireTelegramUserId(value: string): string {
  const normalized = requireCredential(value, "user id");
  if (!/^\d+$/.test(normalized)) throw new Error("Telegram user id must be numeric");
  return normalized;
}

function requireTelegramBotToken(value: string): string {
  const normalized = requireCredential(value, "bot token");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error("Telegram bot token has an invalid format");
  }
  return normalized;
}

function publicErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Unknown error";
}

function redactTelegramFetchError(value: unknown, botToken: string): string {
  const raw = value instanceof Error ? `${value.name}: ${value.message}` : "Unknown error";
  return raw
    .replaceAll(botToken, "[REDACTED]")
    .replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/g, "https://api.telegram.org/bot[REDACTED]")
    .slice(0, 500);
}

function formatShanghaiDateTime(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}
