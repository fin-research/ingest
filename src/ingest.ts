import {
  fetchResearchReportList,
  fetchSubscribedWechatList,
  articleDedupeKey,
  shanghaiDate,
  type ArticleMetadata,
  type Fetcher,
  workflowInstanceId,
} from "./article";
import { dataFetcher } from "./data-fetcher";

export interface CollectionSummary {
  fetched: number;
  existing: number;
  workflows: number;
}

export interface ArticleRepository {
  findExisting(articles: ArticleMetadata[]): Promise<Set<string>>;
}

export interface ArticleWorkflowLauncher {
  start(articles: ArticleMetadata[]): Promise<string[]>;
}

interface CollectorDependencies {
  apiBaseUrl: string;
  repository: ArticleRepository;
  workflow: ArticleWorkflowLauncher;
  fetcher?: Fetcher;
}

export async function collectResearchReports(env: Env): Promise<CollectionSummary> {
  const repository = new D1ArticleRepository(env.DB);
  const workflow = new CloudflareArticleWorkflowLauncher(env.ARTICLE_WORKFLOW);
  const fetcher = dataFetcher(env);
  return await runCollection(
    {
      apiBaseUrl: env.ARTICLE_API_BASE_URL,
      fetcher,
      repository,
      workflow,
    },
  );
}

export async function runCollection(
  dependencies: CollectorDependencies,
): Promise<CollectionSummary> {
  const sources = await Promise.allSettled([
    fetchResearchReportList(dependencies.apiBaseUrl, dependencies.fetcher),
    fetchSubscribedWechatList(dependencies.apiBaseUrl, dependencies.fetcher),
  ]);
  if (sources.every((result) => result.status === "rejected")) throw new Error("all research sources are unavailable");
  const articles: ArticleMetadata[] = [];
  for (const [index, result] of sources.entries()) {
    if (result.status === "fulfilled") articles.push(...result.value);
    else console.error(JSON.stringify({ event: "research_source_unavailable", source: index === 0 ? "news" : "wechat",
      error: result.reason instanceof Error ? result.reason.message : "Unknown error" }));
  }
  if (articles.length === 0) return { fetched: 0, existing: 0, workflows: 0 };

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
  let workflowCount = 0;
  for (let offset = 0; offset < candidates.length; offset += 100) {
    workflowCount += (await dependencies.workflow.start(candidates.slice(offset, offset + 100))).length;
  }
  return { fetched: articles.length, existing: articles.length - candidates.length, workflows: workflowCount };
}

export class D1ArticleRepository implements ArticleRepository {
  constructor(private readonly database: D1Database) {}

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

export class CloudflareArticleWorkflowLauncher implements ArticleWorkflowLauncher {
  constructor(private readonly workflow: Env["ARTICLE_WORKFLOW"]) {}

  async start(articles: ArticleMetadata[]): Promise<string[]> {
    // Existing IDs may be silently omitted by createBatch. They stay unchanged;
    // collection never queries, restarts, or rebuilds an existing workflow.
    const ids: string[] = [];
    let batch: { id: string; params: ArticleMetadata }[] = [];
    let bytes = 2;
    for (const article of articles) {
      const option = { id: workflowInstanceId(article), params: article };
      const size = new TextEncoder().encode(JSON.stringify(option)).byteLength + 1;
      // Keep room under the 1MiB batch RPC limit for its transport envelope.
      if (batch.length && (batch.length >= 100 || bytes + size > 900 * 1024)) {
        ids.push(...(await this.workflow.createBatch(batch)).map((instance) => instance.id));
        batch = []; bytes = 2;
      }
      batch.push(option); bytes += size;
    }
    if (batch.length) ids.push(...(await this.workflow.createBatch(batch)).map((instance) => instance.id));
    return ids;
  }
}

// ECMAScript trim's whitespace set, shared by SQL lookups and atomic inserts.
const TRIM_TITLE_SQL = "trim(title, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))";

/** Called only by the Workflow metadata step; retries preserve its own ID. */
export async function storeArticleMetadata(database: D1Database, article: ArticleMetadata, createdAt: string): Promise<boolean> {
  const result = await database.prepare(`
    INSERT INTO article (id, news_id, title, published_at, created_at, updated_at, link)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM article WHERE ${TRIM_TITLE_SQL} = ? AND date(published_at, '+8 hours') = ?)
    ON CONFLICT(id) DO NOTHING
  `).bind(article.id, article.newsId ?? null, article.title.trim(), article.publishedAt,
    createdAt, createdAt, article.sourceUrl ?? null, article.title.trim(), shanghaiDate(article.publishedAt)).run();
  if (result.meta.changes) return true;
  return !!await database.prepare("SELECT id FROM article WHERE id = ?").bind(article.id).first("id");
}
