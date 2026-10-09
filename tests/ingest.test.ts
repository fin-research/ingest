import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { articleDedupeKey, type ArticleMetadata } from "../src/article";
import { type ArticleRepository, type ArticleWorkflowLauncher, runCollection, D1ArticleRepository, storeArticleMetadata } from "../src/ingest";

class MemoryRepository implements ArticleRepository {
  readonly rows = new Map<string, ArticleMetadata>();
  async findExisting(articles: ArticleMetadata[]): Promise<Set<string>> {
    const keys = new Set([...this.rows.values()].map(articleDedupeKey));
    return new Set(articles.filter((article) => this.rows.has(article.id) || keys.has(articleDedupeKey(article))).map((article) => article.id));
  }
}
class MemoryWorkflow implements ArticleWorkflowLauncher {
  readonly batches: ArticleMetadata[][] = [];
  async start(articles: ArticleMetadata[]): Promise<string[]> {
    this.batches.push(articles);
    return articles.map((article) => `article-${article.id}`);
  }
}
const apiPayload = [
  { sentimentId: "S1", newsId: "N1", title: "研报一", time: "2026-10-02T09:00:00+08:00", tags: ["市场解读"] },
  { sentimentId: "S2", newsId: "N2", title: "研报二", time: "2026-10-02T09:05:00+08:00", tags: ["市场解读"] },
];
const fetcher = async (input: RequestInfo | URL) => Response.json(new URL(String(input)).pathname.endsWith("/wechat-articles") ? [] : apiPayload);
const apiBaseUrl = "https://eastmoney.hasbai.xyz/data";
const longUrl = "https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1&sn=test";
function subscribed(id: string, title: string, time = "2026-10-02T09:00:00+08:00") {
  return { sentimentId: id, title, time, accountName: "关注公众号", url: longUrl };
}

describe("scheduled ingest", () => {
  it("launches metadata directly without writing D1 or downloading detail, then skips records stored by the workflow", async () => {
    const repository = new MemoryRepository(); const workflow = new MemoryWorkflow();
    const dependencies = { apiBaseUrl, repository, workflow, fetcher };
    expect(await runCollection(dependencies)).toEqual({ fetched: 2, existing: 0, workflows: 2 });
    expect(repository.rows.size).toBe(0);
    // Metadata is persisted by the workflow, outside the collector.
    workflow.batches.flat().forEach((article) => repository.rows.set(article.id, article));
    expect(await runCollection(dependencies)).toEqual({ fetched: 2, existing: 2, workflows: 0 });
    expect(workflow.batches).toHaveLength(1);
  });

  it("does not leave a D1 claim on launch failure and can launch on the next normal scan", async () => {
    const repository = new MemoryRepository(); const successful = new MemoryWorkflow();
    await expect(runCollection({ apiBaseUrl, repository, fetcher, workflow: {
      async start() { throw new Error("workflow unavailable"); },
    } })).rejects.toThrow("workflow unavailable");
    expect(repository.rows.size).toBe(0);
    expect(await runCollection({ apiBaseUrl, repository, fetcher, workflow: successful })).toMatchObject({ workflows: 2 });
  });

  it("prefers news for same-title same-Shanghai-date duplicates and sends only subscription metadata", async () => {
    const repository = new MemoryRepository(); const workflow = new MemoryWorkflow(); const requests: string[] = [];
    expect(await runCollection({ apiBaseUrl, repository, workflow,
      fetcher: async (input) => {
        const url = new URL(String(input)); requests.push(url.pathname);
        if (url.pathname.endsWith("/news")) return Response.json([apiPayload[0]]);
        expect(url.searchParams.get("onlySubscription")).toBe("true");
        return Response.json([subscribed("W1", "研报一", "2026-10-02T01:30:00Z"), subscribed("W2", "假期研报", "2026-10-01T23:00:00Z")]);
      },
    })).toEqual({ fetched: 3, existing: 1, workflows: 2 });
    expect(workflow.batches[0]).toEqual([
      { id: "S1", newsId: "N1", title: "研报一", publishedAt: apiPayload[0]!.time },
      { id: "W2", title: "假期研报", publishedAt: "2026-10-01T23:00:00Z", source: "wechat", sourceUrl: longUrl },
    ]);
    expect(requests).toEqual(["/data/news", "/data/wechat-articles"]);
    expect(repository.rows.size).toBe(0);
  });

  it("collects news when subscriptions fail and subscriptions when news fails", async () => {
    for (const failedSource of ["news", "wechat-articles"]) {
      const repository = new MemoryRepository(); const workflow = new MemoryWorkflow();
      await runCollection({ apiBaseUrl, repository, workflow, fetcher: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/" + failedSource)) return new Response("unavailable", { status: 503 });
        return Response.json(path.endsWith("/news") ? apiPayload : [subscribed("W1", "公众号文章")]);
      } });
      expect(workflow.batches.flat()).toHaveLength(failedSource === "news" ? 1 : 2);
    }
  });

  it("dispatches batches of at most 100 metadata records without D1 writes", async () => {
    const repository = new MemoryRepository(); const workflow = new MemoryWorkflow();
    await runCollection({ apiBaseUrl, repository, workflow,
      fetcher: async (input) => Response.json(new URL(String(input)).pathname.endsWith("/wechat-articles") ? [] :
        Array.from({ length: 101 }, (_, index) => ({ ...apiPayload[0], sentimentId: `N${index}`, title: `文章${index}` }))),
    });
    expect(workflow.batches.map((batch) => batch.length)).toEqual([100, 1]);
    expect(repository.rows.size).toBe(0);
  });
});

describe("Workflow metadata idempotency and Shanghai date deduplication", () => {
  beforeEach(async () => {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS article (id TEXT PRIMARY KEY, news_id TEXT, title TEXT NOT NULL, published_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, link TEXT, prompt_version TEXT)").run();
    await env.DB.prepare("DELETE FROM article").run();
  });

  it("allows only one concurrent source to continue but accepts a later Shanghai date", async () => {
    const repository = new D1ArticleRepository(env.DB);
    const a = { id: "A", title: "同标题", publishedAt: "2026-10-01T23:30:00Z" };
    const b = { id: "B", title: "同标题", publishedAt: "2026-10-02T12:00:00+08:00" };
    const owned = await Promise.all([storeArticleMetadata(env.DB, a, a.publishedAt), storeArticleMetadata(env.DB, b, b.publishedAt)]);
    expect(owned.filter(Boolean)).toHaveLength(1);
    expect(await repository.findExisting([a, b])).toEqual(new Set(["A", "B"]));
    expect(await storeArticleMetadata(env.DB, { ...a, id: "C", publishedAt: "2026-10-02T16:30:00Z" }, a.publishedAt)).toBe(true);
  });

  it("allows its own metadata step to retry without changing the existing timestamps or link", async () => {
    const article = { id: "own", title: "同标题", publishedAt: "2026-10-01T23:30:00Z", source: "wechat" as const, sourceUrl: longUrl };
    expect(await storeArticleMetadata(env.DB, article, "2026-10-02T00:00:00Z")).toBe(true);
    expect(await storeArticleMetadata(env.DB, article, "2026-10-03T00:00:00Z")).toBe(true);
    expect(await env.DB.prepare("SELECT created_at, updated_at, link FROM article WHERE id = ?").bind(article.id).first()).toEqual({
      created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", link: longUrl,
    });
  });

  it("queries 200 candidates within D1 parameter limits", async () => {
    const repository = new D1ArticleRepository(env.DB);
    const rows = Array.from({ length: 200 }, (_, index) => ({ id: `A${index}`, title: `标题${index}`, publishedAt: "2026-10-01T10:00:00+08:00" }));
    for (const row of rows) await storeArticleMetadata(env.DB, row, "2026-10-01T00:00:00Z");
    expect((await repository.findExisting(rows)).size).toBe(200);
  });

  it("matches historical whitespace and skips another ID without changing old metadata", async () => {
    const repository = new D1ArticleRepository(env.DB);
    await env.DB.prepare("INSERT INTO article (id,title,published_at,created_at,updated_at,link) VALUES (?,?,?,?,?,?)")
      .bind("old", "　同标题\t", "2026-10-01T23:30:00Z", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", longUrl).run();
    const candidate = { id: "new", title: "同标题", publishedAt: "2026-10-02T12:00:00+08:00" };
    expect(await repository.findExisting([candidate])).toEqual(new Set(["new"]));
    expect(await storeArticleMetadata(env.DB, candidate, candidate.publishedAt)).toBe(false);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM article").first("count")).toBe(1);
  });
});
