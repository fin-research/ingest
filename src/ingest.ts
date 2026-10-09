import {
  fetchResearchReportList,
  fetchSubscribedWechatList,
  fetchResearchReportDetail,
  assertWorkflowPayloadFits,
  articleDedupeKey,
  shanghaiDate,
  isWechatLongArticleUrl,
  WECHAT_SUBSCRIPTION_START_DATE,
  type ArticleMetadata,
  type ArticleWorkflowParams,
  type Fetcher,
  workflowInstanceId,
} from "./article";
import { dataFetcher } from "./data-fetcher";

export interface CollectionSummary {
  fetched: number;
  existing: number;
  inserted: number;
  workflows: number;
  skipped?: number;
  deferred?: number;
}

export interface ArticleRepository {
  findExisting(articles: ArticleMetadata[]): Promise<Set<string>>;
  insertIfAbsent(articles: ArticleMetadata[], createdAt: string): Promise<ArticleMetadata[]>;
  remove(ids: string[]): Promise<void>;
}

export interface ArticleWorkflowLauncher {
  start(articles: ArticleWorkflowParams[]): Promise<string[]>;
}

interface CollectorDependencies {
  apiBaseUrl: string;
  repository: ArticleRepository;
  workflow: ArticleWorkflowLauncher;
  fetcher?: Fetcher;
}

export async function collectResearchReports(env: Env, createdAt: string): Promise<CollectionSummary> {
  const repository = new D1ArticleRepository(env.DB);
  const workflow = new CloudflareArticleWorkflowLauncher(env.ARTICLE_WORKFLOW);
  const fetcher = dataFetcher(env);
  await workflow.reconcile(await repository.findPending(), env.ARTICLE_API_BASE_URL, fetcher, createdAt);
  return await runCollection(
    {
      apiBaseUrl: env.ARTICLE_API_BASE_URL,
      fetcher,
      repository,
      workflow,
    },
    createdAt,
  );
}

export async function runCollection(
  dependencies: CollectorDependencies,
  createdAt: string,
): Promise<CollectionSummary> {
  const sources = await Promise.allSettled([
    fetchResearchReportList(dependencies.apiBaseUrl, dependencies.fetcher),
    fetchSubscribedWechatList(dependencies.apiBaseUrl, dependencies.fetcher),
  ]);
  if (sources.every((result) => result.status === "rejected")) throw new Error("all research sources are unavailable");
  const articles: ArticleMetadata[] = [];
  for (const [index, result] of sources.entries()) {
    if (result.status === "fulfilled") articles.push(...result.value);
    else console.error(JSON.stringify({ event: "research_source_unavailable", source: index === 0 ? "news" : "wechat", error: errorMessage(result.reason) }));
  }
  if (articles.length === 0) return { fetched: 0, existing: 0, inserted: 0, workflows: 0 };

  const existingIds = await dependencies.repository.findExisting(articles);
  const candidates: ArticleMetadata[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  // News comes first so a simultaneous duplicate keeps its established workflow.
  for (const article of articles) {
    const key = articleDedupeKey(article);
    if (existingIds.has(article.id) || ids.has(article.id) || keys.has(key)) continue;
    ids.add(article.id); keys.add(key); candidates.push(article);
  }
  if (candidates.length === 0) {
    return { fetched: articles.length, existing: articles.length, inserted: 0, workflows: 0 };
  }

  const prepared = new Map<string, ArticleWorkflowParams>();
  const subscriptions = candidates.filter((article) => article.source === "wechat");
  const selected = rotatingSlice(subscriptions, 8, createdAt);
  const selectedIds = new Set(selected.map((article) => article.id));
  const preparationCandidates = candidates.filter((article) => article.source !== "wechat" || selectedIds.has(article.id));
  const deferred = candidates.length - preparationCandidates.length;
  let cursor = 0;
  // Bound HTTP concurrency; empty/failed details never claim a D1 identity.
  await Promise.all(Array.from({ length: Math.min(4, preparationCandidates.length) }, async () => {
    while (cursor < preparationCandidates.length) {
      const article = preparationCandidates[cursor++]!;
      try {
        const params = await prepareWorkflowArticle(dependencies.apiBaseUrl, article, dependencies.fetcher);
        prepared.set(article.id, params);
      } catch (error) {
        console.warn(JSON.stringify({ event: "subscribed_article_skipped", articleId: article.id, error: errorMessage(error) }));
      }
    }
  }));
  const ready = candidates.flatMap((article) => prepared.has(article.id) ? [prepared.get(article.id)!] : []);
  const skipped = preparationCandidates.length - ready.length;
  let insertedCount = 0;
  let workflowCount = 0;
  // Complete each dispatch before inserting the next batch; later failures cannot
  // roll back articles belonging to an earlier successful batch.
  for (const batch of articleDispatchBatches(ready)) {
    const inserted = await dependencies.repository.insertIfAbsent(batch, createdAt);
    if (!inserted.length) continue;
    try {
      const instances = await dependencies.workflow.start(inserted.map((article) => prepared.get(article.id)!));
      insertedCount += inserted.length;
      workflowCount += instances.length;
    } catch (error) {
      // Another Cron may already be recovering an apparently missing instance.
      // Keep every claim; independent reconciliation retries stable IDs next scan.
      throw error;
    }
  }
  return { fetched: articles.length, existing: articles.length - insertedCount - skipped - deferred,
    inserted: insertedCount, workflows: workflowCount, ...(skipped ? { skipped } : {}), ...(deferred ? { deferred } : {}) };
}

export class D1ArticleRepository implements ArticleRepository {
  constructor(private readonly database: D1Database) {}

  async findPending(): Promise<ArticleMetadata[]> {
    const rows = await this.database.prepare(`SELECT id, news_id, title, published_at, link
      FROM article WHERE prompt_version IS NULL
      AND date(published_at, '+8 hours') >= ? ORDER BY created_at, id`).bind(WECHAT_SUBSCRIPTION_START_DATE).all<{
        id: string; news_id: string | null; title: string; published_at: string; link: string | null;
      }>();
    // Newly inserted news has no link until its workflow downloads DM detail;
    // subscriptions persist their original long URL before dispatch.
    return rows.results.map((row) => ({ id: row.id, title: row.title, publishedAt: row.published_at,
      ...(row.news_id ? { newsId: row.news_id } : {}),
      ...(!row.news_id && row.link && isWechatLongArticleUrl(row.link) ? { source: "wechat" as const, sourceUrl: row.link } : {}),
    }));
  }

  async findExisting(articles: ArticleMetadata[]): Promise<Set<string>> {
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (let offset = 0; offset < articles.length; offset += 20) {
      const chunk = articles.slice(offset, offset + 20);
      const dates = [...new Set(chunk.map((article) => shanghaiDate(article.publishedAt)))];
      const titles = [...new Set(chunk.map((article) => article.title.trim()))];
      const placeholders = (values: string[]) => values.map(() => "?").join(",");
      const result = await this.database.prepare(`SELECT id, title, published_at FROM article
        WHERE id IN (${placeholders(chunk.map((article) => article.id))})
        OR (date(published_at, '+8 hours') IN (${placeholders(dates)}) AND ${TRIM_TITLE_SQL} IN (${placeholders(titles)}))`)
        .bind(...chunk.map((article) => article.id), ...dates, ...titles)
        .all<{ id: string; title: string; published_at: string }>();
      for (const row of result.results) {
        ids.add(row.id);
        keys.add(articleDedupeKey({ id: row.id, title: row.title, publishedAt: row.published_at }));
      }
    }
    return new Set(articles.filter((article) => ids.has(article.id) || keys.has(articleDedupeKey(article))).map((article) => article.id));
  }

  async insertIfAbsent(articles: ArticleMetadata[], createdAt: string): Promise<ArticleMetadata[]> {
    if (articles.length === 0) return [];
    const statement = this.database.prepare(`
      INSERT INTO article (id, news_id, title, published_at, created_at, updated_at, link)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM article WHERE ${TRIM_TITLE_SQL} = ? AND date(published_at, '+8 hours') = ?)
      ON CONFLICT(id) DO NOTHING
    `);
    const results = await this.database.batch(
      articles.map((article) =>
        statement.bind(
          article.id,
          article.newsId ?? null,
          article.title.trim(),
          article.publishedAt,
          createdAt,
          createdAt,
          article.sourceUrl ?? null,
          article.title.trim(),
          shanghaiDate(article.publishedAt),
        ),
      ),
    );
    return articles.filter((_, index) => (results[index]?.meta.changes ?? 0) > 0);
  }

  async remove(ids: string[]): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return;
    for (let offset = 0; offset < uniqueIds.length; offset += 80) {
      const chunk = uniqueIds.slice(offset, offset + 80);
      await this.database.prepare(`DELETE FROM article WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
    }
  }
}

export async function updateArticleLink(
  database: D1Database,
  articleId: string,
  link: string,
): Promise<void> {
  await database
    .prepare(
      "UPDATE article SET link = ?, updated_at = ? WHERE id = ? AND (link IS NULL OR link != ?)",
    )
    .bind(link, new Date().toISOString(), articleId, link)
    .run();
}

export class WorkflowDispatchError extends Error {
  constructor(message: string, readonly retainedArticleIds: Set<string>) { super(message); }
}

export class CloudflareArticleWorkflowLauncher implements ArticleWorkflowLauncher {
  constructor(private readonly workflow: Env["ARTICLE_WORKFLOW"]) {}

  async reconcile(pending: ArticleMetadata[], apiBaseUrl: string, fetcher?: Fetcher, scheduledAt = new Date().toISOString()): Promise<void> {
    const selected = rotatingSlice(pending, 5, scheduledAt);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
      while (cursor < selected.length) {
        const article = selected[cursor++]!;
        try {
          try {
            const instance = await this.workflow.get(workflowInstanceId(article));
            const status = await instance.status();
            if (status.status === "errored") await instance.restart();
            if (status.status === "unknown" || status.status === "terminated") {
              throw new Error(`article workflow is ${status.status}`);
            }
          } catch (error) {
            if (!isInstanceMissing(error)) throw error;
            const params = await prepareWorkflowArticle(apiBaseUrl, article, fetcher);
            await this.start([params]);
            console.log(JSON.stringify({ event: "article_dispatch_recovered", articleId: article.id }));
          }
        } catch (error) {
          console.error(JSON.stringify({ event: "article_dispatch_reconcile_failed", articleId: article.id, error: errorMessage(error) }));
        }
      }
    }));
  }

  async start(articles: ArticleWorkflowParams[]): Promise<string[]> {
    if (articles.length === 0) return [];
    let returned = new Set<string>();
    try {
      const options = articles.map((article) => ({ id: workflowInstanceId(article), params: article }));
      const instances = articles.length === 1
        ? [await this.workflow.create(options[0]!)]
        : await this.workflow.createBatch(options);
      returned = new Set(instances.map((instance) => instance.id));
    } catch (error) {
      console.error(JSON.stringify({ event: "article_create_batch_failed", count: articles.length,
        payloadBytes: new TextEncoder().encode(JSON.stringify(articles.map((params) => ({ id: workflowInstanceId(params), params })))).byteLength,
        error: errorMessage(error) }));
      // All claims remain recoverable. Avoid another unbounded status scan in
      // the failed Cron; the next bounded reconciliation resolves uncertainty.
      throw new WorkflowDispatchError(errorMessage(error), new Set(articles.map((article) => article.id)));
    }
    if (articles.some((article) => !returned.has(workflowInstanceId(article)))) {
      throw new WorkflowDispatchError("article dispatch deferred to reconciliation", new Set(articles.map((article) => article.id)));
    }
    return articles.map(workflowInstanceId);
  }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isInstanceMissing(error: unknown): boolean {
  return /not[ _.-]?found|not exist/i.test(errorMessage(error));
}

async function prepareWorkflowArticle(apiBaseUrl: string, article: ArticleMetadata, fetcher?: Fetcher): Promise<ArticleWorkflowParams> {
  const params: ArticleWorkflowParams = article.source === "wechat"
    ? { ...article, subscriptionContent: (await fetchResearchReportDetail(apiBaseUrl, article, fetcher)).content }
    : article;
  assertWorkflowPayloadFits(params);
  return params;
}

// ECMAScript trim's whitespace set, shared by SQL lookups and atomic inserts.
const TRIM_TITLE_SQL = "trim(title, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))";

export function articleDispatchBatches(articles: ArticleWorkflowParams[]): ArticleWorkflowParams[][] {
  const batches: ArticleWorkflowParams[][] = [];
  let batch: ArticleWorkflowParams[] = [];
  let bytes = 2;
  // createBatch also has a 1MiB RPC cap across the entire batch. Leave room for
  // its transport envelope; large single payloads use create instead.
  for (const article of articles) {
    const size = new TextEncoder().encode(JSON.stringify({ id: workflowInstanceId(article), params: article })).byteLength + 1;
    if (batch.length && (batch.length >= 100 || bytes + size > 900 * 1024)) {
      batches.push(batch); batch = []; bytes = 2;
    }
    batch.push(article); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function rotatingSlice<T>(items: T[], limit: number, scheduledAt: string): T[] {
  if (items.length <= limit) return items;
  const offset = (Math.floor(new Date(scheduledAt).valueOf() / 300_000) * limit) % items.length;
  return Array.from({ length: limit }, (_, index) => items[(offset + index) % items.length]!);
}
