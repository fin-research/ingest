import { fetchCentralBankPolicyNews, type ArticleMetadata, type Fetcher } from "./article";

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
  deliveries: Array<{ articleId: string; messageId: number | string }>;
}

export async function createTelegramNotifier(env: Pick<Env, "MESSENGER">) {
  return new MessengerNotifier(env.MESSENGER);
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
      fetcher: dataFetcher(env),
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
      .prepare(`SELECT article_id FROM telegram_delivery WHERE article_id IN (${placeholders}) AND (sent_at IS NOT NULL OR messenger_id IS NOT NULL)`)
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
          AND sent_at IS NULL AND messenger_id IS NULL
      `)
      .bind(...articles.map((article) => article.id))
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

  async markSubmitted(articleId: string, id: string): Promise<void> {
    await this.database.prepare("UPDATE telegram_delivery SET messenger_id=?,submitted_at=? WHERE article_id=? AND sent_at IS NULL")
      .bind(id, new Date().toISOString(), articleId).run();
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

export class MessengerNotifier {
  constructor(private readonly binding: { fetch(input: Request): Promise<Response> }) {}
  async send(article: ArticleMetadata): Promise<string> {
    const response = await this.binding.fetch(new Request("https://messenger.internal/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "ingest", channel: "telegram", idempotencyKey: `central-bank/${article.id}`, text: formatCentralBankNotification(article) }),
    }));
    if (!response.ok) throw new Error(`Messenger submission failed: ${response.status}`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") throw new Error("Messenger response is missing id");
    return value.id;
  }
}
export function formatCentralBankNotification(article: ArticleMetadata): string {
  return `${article.title}\n发布时间：${formatShanghaiDateTime(article.publishedAt)}`;
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
import { dataFetcher } from './data-fetcher';
