import {
  fetchResearchReportList,
  type ArticleMetadata,
  type Fetcher,
  workflowInstanceId,
} from "./article";

export interface CollectionSummary {
  fetched: number;
  existing: number;
  inserted: number;
  workflows: number;
}

export interface ArticleRepository {
  findExistingIds(ids: string[]): Promise<Set<string>>;
  insertIfAbsent(articles: ArticleMetadata[], createdAt: string): Promise<ArticleMetadata[]>;
  remove(ids: string[]): Promise<void>;
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

export async function collectResearchReports(env: Env, createdAt: string): Promise<CollectionSummary> {
  return await runCollection(
    {
      apiBaseUrl: env.ARTICLE_API_BASE_URL,
      repository: new D1ArticleRepository(env.DB),
      workflow: new CloudflareArticleWorkflowLauncher(env.ARTICLE_WORKFLOW),
    },
    createdAt,
  );
}

export async function runCollection(
  dependencies: CollectorDependencies,
  createdAt: string,
): Promise<CollectionSummary> {
  const articles = await fetchResearchReportList(dependencies.apiBaseUrl, dependencies.fetcher);
  if (articles.length === 0) return { fetched: 0, existing: 0, inserted: 0, workflows: 0 };

  const existingIds = await dependencies.repository.findExistingIds(
    articles.map((article) => article.id),
  );
  const candidates = articles.filter((article) => !existingIds.has(article.id));
  if (candidates.length === 0) {
    return { fetched: articles.length, existing: articles.length, inserted: 0, workflows: 0 };
  }

  const inserted = await dependencies.repository.insertIfAbsent(candidates, createdAt);
  if (inserted.length === 0) {
    return { fetched: articles.length, existing: articles.length, inserted: 0, workflows: 0 };
  }

  try {
    const instances = await dependencies.workflow.start(inserted);
    return {
      fetched: articles.length,
      existing: articles.length - inserted.length,
      inserted: inserted.length,
      workflows: instances.length,
    };
  } catch (error) {
    await dependencies.repository.remove(inserted.map((article) => article.id));
    throw error;
  }
}

export class D1ArticleRepository implements ArticleRepository {
  constructor(private readonly database: D1Database) {}

  async findExistingIds(ids: string[]): Promise<Set<string>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return new Set();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const result = await this.database
      .prepare(`SELECT id FROM article WHERE id IN (${placeholders})`)
      .bind(...uniqueIds)
      .all<{ id: string }>();
    return new Set(result.results.map((row) => row.id));
  }

  async insertIfAbsent(articles: ArticleMetadata[], createdAt: string): Promise<ArticleMetadata[]> {
    if (articles.length === 0) return [];
    const statement = this.database.prepare(`
      INSERT INTO article (id, news_id, title, published_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    const results = await this.database.batch(
      articles.map((article) =>
        statement.bind(
          article.id,
          article.newsId ?? null,
          article.title,
          article.publishedAt,
          createdAt,
          createdAt,
        ),
      ),
    );
    return articles.filter((_, index) => (results[index]?.meta.changes ?? 0) > 0);
  }

  async remove(ids: string[]): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return;
    const placeholders = uniqueIds.map(() => "?").join(", ");
    await this.database
      .prepare(`DELETE FROM article WHERE id IN (${placeholders})`)
      .bind(...uniqueIds)
      .run();
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

class CloudflareArticleWorkflowLauncher implements ArticleWorkflowLauncher {
  constructor(private readonly workflow: Env["ARTICLE_WORKFLOW"]) {}

  async start(articles: ArticleMetadata[]): Promise<string[]> {
    if (articles.length === 0) return [];
    const instances = await this.workflow.createBatch(
      articles.map((article) => ({ id: workflowInstanceId(article), params: article })),
    );
    return instances.map((instance) => instance.id);
  }
}
