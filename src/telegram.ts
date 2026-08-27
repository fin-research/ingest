import { fetchCentralBankPolicyNews, readTextBounded, type ArticleMetadata, type Fetcher } from "./article";

const MAX_TELEGRAM_RESPONSE_BYTES = 64 * 1024;
const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export interface TelegramCollectionSummary {
  matched: number;
  existing: number;
  queued: number;
  workflows: number;
}

export interface TelegramDeliveryRepository {
  findExistingIds(ids: string[]): Promise<Set<string>>;
  insertPending(
    articles: ArticleMetadata[],
    discoveredAt: string,
    workflowInstanceId: string,
  ): Promise<ArticleMetadata[]>;
  findDeliveredMessageIds(ids: string[]): Promise<Map<string, number>>;
  markDelivered(articleId: string, sentAt: string, messageId: number): Promise<void>;
}

export interface TelegramNotifier {
  send(article: ArticleMetadata): Promise<number>;
}

export interface TelegramWorkflowLauncher {
  start(articles: ArticleMetadata[], discoveredAt: string): Promise<string>;
}

interface TelegramCollectorDependencies {
  apiBaseUrl: string;
  repository: TelegramDeliveryRepository;
  workflow: TelegramWorkflowLauncher;
  fetcher?: Fetcher;
}

export interface TelegramWorkflowParams {
  articles: ArticleMetadata[];
  discoveredAt: string;
}

export interface TelegramDeliverySummary {
  stored: number;
  sent: number;
  alreadySent: number;
  deliveries: Array<{ articleId: string; messageId: number }>;
}

export async function createTelegramNotifier(
  env: Pick<Env, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_USER_ID">,
): Promise<TelegramNotifier> {
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
}

export async function runCentralBankNotificationCollection(
  dependencies: TelegramCollectorDependencies,
  discoveredAt: string,
): Promise<TelegramCollectionSummary> {
  const articles = await fetchCentralBankPolicyNews(
    dependencies.apiBaseUrl,
    dependencies.fetcher,
  );
  if (articles.length === 0) {
    return { matched: 0, existing: 0, queued: 0, workflows: 0 };
  }

  const existingIds = await dependencies.repository.findExistingIds(
    articles.map((article) => article.id),
  );
  const pending = articles.filter((article) => !existingIds.has(article.id));
  if (pending.length === 0) {
    return { matched: articles.length, existing: articles.length, queued: 0, workflows: 0 };
  }

  await dependencies.workflow.start(pending, discoveredAt);
  return {
    matched: articles.length,
    existing: existingIds.size,
    queued: pending.length,
    workflows: 1,
  };
}

export async function collectCentralBankNotifications(
  env: Env,
  discoveredAt: string,
): Promise<TelegramCollectionSummary> {
  return await runCentralBankNotificationCollection(
    {
      apiBaseUrl: env.ARTICLE_API_BASE_URL,
      repository: new D1TelegramDeliveryRepository(env.DB),
      workflow: new CloudflareTelegramWorkflowLauncher(env.TELEGRAM_WORKFLOW),
    },
    discoveredAt,
  );
}

export class D1TelegramDeliveryRepository implements TelegramDeliveryRepository {
  constructor(private readonly database: D1Database) {}

  async findExistingIds(ids: string[]): Promise<Set<string>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return new Set();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const result = await this.database
      .prepare(`SELECT article_id FROM telegram_delivery WHERE article_id IN (${placeholders})`)
      .bind(...uniqueIds)
      .all<{ article_id: string }>();
    return new Set(result.results.map((row) => row.article_id));
  }

  async insertPending(
    articles: ArticleMetadata[],
    discoveredAt: string,
    workflowInstanceId: string,
  ): Promise<ArticleMetadata[]> {
    if (articles.length === 0) return [];
    const statement = this.database.prepare(`
        INSERT INTO telegram_delivery (
          article_id, title, published_at, discovered_at, workflow_instance_id
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(article_id) DO NOTHING
      `);
    await this.database.batch(
      articles.map((article) => statement.bind(
        article.id,
        article.title,
        article.publishedAt,
        discoveredAt,
        workflowInstanceId,
      )),
    );
    const placeholders = articles.map(() => "?").join(", ");
    const owned = await this.database
      .prepare(`
        SELECT article_id
        FROM telegram_delivery
        WHERE article_id IN (${placeholders})
          AND workflow_instance_id = ?
          AND sent_at IS NULL
      `)
      .bind(...articles.map((article) => article.id), workflowInstanceId)
      .all<{ article_id: string }>();
    const ownedIds = new Set(owned.results.map((row) => row.article_id));
    return articles.filter((article) => ownedIds.has(article.id));
  }

  async findDeliveredMessageIds(ids: string[]): Promise<Map<string, number>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return new Map();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const result = await this.database
      .prepare(`
        SELECT article_id, telegram_message_id
        FROM telegram_delivery
        WHERE article_id IN (${placeholders}) AND telegram_message_id IS NOT NULL
      `)
      .bind(...uniqueIds)
      .all<{ article_id: string; telegram_message_id: number }>();
    return new Map(result.results.map((row) => [row.article_id, row.telegram_message_id]));
  }

  async markDelivered(articleId: string, sentAt: string, messageId: number): Promise<void> {
    const result = await this.database
      .prepare(`
        UPDATE telegram_delivery
        SET sent_at = ?, telegram_message_id = ?
        WHERE article_id = ? AND telegram_message_id IS NULL
      `)
      .bind(sentAt, messageId, articleId)
      .run();
    if (result.meta.changes !== 1) {
      throw new Error(`Telegram delivery row is unavailable for article ${articleId}`);
    }
  }
}

export class CloudflareTelegramWorkflowLauncher implements TelegramWorkflowLauncher {
  constructor(private readonly workflow: Env["TELEGRAM_WORKFLOW"]) {}

  async start(articles: ArticleMetadata[], discoveredAt: string): Promise<string> {
    const instance = await this.workflow.create({
      id: telegramWorkflowInstanceId(discoveredAt),
      params: { articles, discoveredAt },
    });
    return instance.id;
  }
}

export function telegramWorkflowInstanceId(discoveredAt: string): string {
  const timestamp = new Date(discoveredAt).valueOf();
  if (!Number.isFinite(timestamp)) throw new Error("Telegram discoveredAt must be an ISO date-time");
  return `telegram-${timestamp}`;
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
      const fetcher = this.fetcher;
      response = await fetcher(endpoint, {
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
