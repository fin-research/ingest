import {
  fetchResearchReportList,
  fetchSubscribedWechatList,
  fetchResearchReportDetail,
  assertWorkflowPayloadFits,
  articleDedupeKey,
  shanghaiDate,
  isWechatLongArticleUrl,
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
  await workflow.reconcile(await repository.findPending(), env.ARTICLE_API_BASE_URL, fetcher);
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
  let cursor = 0;
  // Bound HTTP concurrency; empty/failed details never claim a D1 identity.
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const article = candidates[cursor++]!;
      try {
        const params = await prepareWorkflowArticle(dependencies.apiBaseUrl, article, dependencies.fetcher);
        prepared.set(article.id, params);
      } catch (error) {
        console.warn(JSON.stringify({ event: "subscribed_article_skipped", articleId: article.id, error: errorMessage(error) }));
      }
    }
  }));
  const ready = candidates.flatMap((article) => prepared.has(article.id) ? [prepared.get(article.id)!] : []);
  const skipped = candidates.length - ready.length;
  let insertedCount = 0;
  let workflowCount = 0;
  // Complete each dispatch before inserting the next batch; later failures cannot
  // roll back articles belonging to an earlier successful batch.
  for (let offset = 0; offset < ready.length; offset += 100) {
    const inserted = await dependencies.repository.insertIfAbsent(ready.slice(offset, offset + 100), createdAt);
    if (!inserted.length) continue;
    try {
      const instances = await dependencies.workflow.start(inserted.map((article) => prepared.get(article.id)!));
      insertedCount += inserted.length;
      workflowCount += instances.length;
    } catch (error) {
      const retained = error instanceof WorkflowDispatchError ? error.retainedArticleIds : new Set<string>();
      await dependencies.repository.remove(inserted.filter((article) => !retained.has(article.id)).map((article) => article.id));
      throw error;
    }
  }
  return { fetched: articles.length, existing: articles.length - insertedCount - skipped,
    inserted: insertedCount, workflows: workflowCount, ...(skipped ? { skipped } : {}) };
}

export class D1ArticleRepository implements ArticleRepository {
  constructor(private readonly database: D1Database) {}

  async findPending(): Promise<ArticleMetadata[]> {
    const rows = await this.database.prepare(`SELECT id, news_id, title, published_at, link
      FROM article WHERE prompt_version IS NULL`).all<{
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

  async reconcile(pending: ArticleMetadata[], apiBaseUrl: string, fetcher?: Fetcher): Promise<void> {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (cursor < pending.length) {
        const article = pending[cursor++]!;
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
    const retained = new Set<string>();
    let failure: unknown;
    let returned = new Set<string>();
    try {
      const instances = await this.workflow.createBatch(articles.map((article) => ({ id: workflowInstanceId(article), params: article })));
      returned = new Set(instances.map((instance) => instance.id));
    } catch { /* Reconcile every requested ID before deciding to roll back. */ }
    for (const article of articles) {
      const id = workflowInstanceId(article);
      if (returned.has(id)) { retained.add(article.id); continue; }
      try {
        const instance = await this.workflow.get(id);
        const status = await instance.status();
        retained.add(article.id);
        if (status.status === "errored") await instance.restart();
        if (status.status === "terminated" || status.status === "unknown") throw new Error(`article workflow is ${status.status}`);
      } catch (error) {
        // An ambiguous transport failure is not proof that the instance was not
        // created. Preserve its row rather than permit a competing source.
        if (!isInstanceMissing(error)) retained.add(article.id);
        failure ??= error;
      }
    }
    if (failure) throw new WorkflowDispatchError(errorMessage(failure), retained);
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
