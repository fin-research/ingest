import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { articleDedupeKey, type ArticleMetadata, type ArticleWorkflowParams } from "../src/article";
import {
  type ArticleRepository,
  type ArticleWorkflowLauncher,
  runCollection,
  D1ArticleRepository,
  CloudflareArticleWorkflowLauncher,
  WorkflowDispatchError,
} from "../src/ingest";

class MemoryRepository implements ArticleRepository {
  readonly rows = new Map<string, ArticleMetadata>();
  readonly removed: string[][] = [];

  async findExisting(articles: ArticleMetadata[]): Promise<Set<string>> {
    const keys = new Set([...this.rows.values()].map(articleDedupeKey));
    return new Set(articles.filter((article) => this.rows.has(article.id) || keys.has(articleDedupeKey(article))).map((article) => article.id));
  }

  async insertIfAbsent(articles: ArticleMetadata[]): Promise<ArticleMetadata[]> {
    const inserted: ArticleMetadata[] = [];
    for (const article of articles) {
      if (this.rows.has(article.id) || [...this.rows.values()].some((row) => articleDedupeKey(row) === articleDedupeKey(article))) continue;
      this.rows.set(article.id, article);
      inserted.push(article);
    }
    return inserted;
  }

  async remove(ids: string[]): Promise<void> {
    this.removed.push(ids);
    for (const id of ids) this.rows.delete(id);
  }
}

class MemoryWorkflow implements ArticleWorkflowLauncher {
  readonly batches: ArticleWorkflowParams[][] = [];

  async start(articles: ArticleWorkflowParams[]): Promise<string[]> {
    this.batches.push(articles);
    return articles.map((article) => `article-${article.id}`);
  }
}

const apiPayload = [
    {
      sentimentId: "S1",
      newsId: "N1",
      title: "研报一",
      time: "2026-08-11T09:00:00+08:00",
      tags: ["市场解读"],
    },
    {
      sentimentId: "S2",
      newsId: "N2",
      title: "研报二",
      time: "2026-08-11T09:05:00+08:00",
      tags: ["市场解读"],
    },
];

const fetcher = async (input: RequestInfo | URL): Promise<Response> =>
  Response.json(new URL(String(input)).pathname.endsWith("/wechat-articles") ? [] : apiPayload);

describe("scheduled ingest", () => {
  it("writes and launches only new articles across repeated scans", async () => {
    const repository = new MemoryRepository();
    const workflow = new MemoryWorkflow();
    const dependencies = {
      apiBaseUrl: "https://eastmoney.hasbai.xyz/data",
      repository,
      workflow,
      fetcher,
    };

    const first = await runCollection(dependencies, "2026-08-11T01:05:00Z");
    const second = await runCollection(dependencies, "2026-08-11T01:10:00Z");

    expect(first).toEqual({ fetched: 2, existing: 0, inserted: 2, workflows: 2 });
    expect(second).toEqual({ fetched: 2, existing: 2, inserted: 0, workflows: 0 });
    expect(workflow.batches).toHaveLength(1);
    expect([...repository.rows]).toHaveLength(2);
  });

  it("retains newly inserted rows for independent reconciliation when dispatch fails", async () => {
    const repository = new MemoryRepository();
    const workflow: ArticleWorkflowLauncher = {
      async start(): Promise<string[]> {
        throw new Error("workflow unavailable");
      },
    };

    await expect(
      runCollection(
        {
          apiBaseUrl: "https://eastmoney.hasbai.xyz/data",
          repository,
          workflow,
          fetcher,
        },
        "2026-08-11T01:05:00Z",
      ),
    ).rejects.toThrow("workflow unavailable");

    expect(repository.rows.size).toBe(2);
    expect(repository.removed).toEqual([]);
  });

  it("prefers news for same-title same-Shanghai-date duplicates and snapshots only new subscriptions", async () => {
    const repository = new MemoryRepository();
    const workflow = new MemoryWorkflow();
    const fetchedDetails: string[] = [];
    const dependencies = { apiBaseUrl: "https://eastmoney.hasbai.xyz/data", repository, workflow,
      fetcher: async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/news")) return Response.json([apiPayload[0]]);
        if (url.pathname.endsWith("/wechat-articles")) {
          expect(url.searchParams.get("onlySubscription")).toBe("true");
          return Response.json([
            subscribed("W1", "研报一", "2026-08-11T01:30:00Z"),
            subscribed("W2", "假期研报", "2026-08-10T23:00:00Z"),
          ]);
        }
        fetchedDetails.push(url.pathname);
        return Response.json({ content: "完整DM文字正文", link: "https://mp.weixin.qq.com/s/unrelated" });
      } };
    expect(await runCollection(dependencies, "2026-08-11T01:05:00Z")).toMatchObject({ fetched: 3, inserted: 2, workflows: 2 });
    expect(workflow.batches[0]).toEqual([expect.objectContaining({ id: "S1" }), expect.objectContaining({ id: "W2", source: "wechat", sourceUrl: longUrl, subscriptionContent: "完整DM文字正文" })]);
    expect(fetchedDetails).toEqual(["/data/news/W2"]);
    expect(await runCollection(dependencies, "2026-08-11T01:10:00Z")).toMatchObject({ inserted: 0, workflows: 0 });
    expect(fetchedDetails).toHaveLength(1);
  });

  it("leaves empty and oversized subscription text unclaimed so later valid news can be collected", async () => {
    const repository = new MemoryRepository(); const workflow = new MemoryWorkflow(); let available = false;
    const dependencies = { apiBaseUrl: "https://eastmoney.hasbai.xyz/data", repository, workflow,
      fetcher: async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/news")) return Response.json(available ? [{ ...apiPayload[0], title: "恢复文章" }] : []);
        if (url.pathname.endsWith("/wechat-articles")) return Response.json([subscribed("W1", "恢复文章"), subscribed("W2", "超限文章")]);
        return Response.json({ content: url.pathname.endsWith("W1") ? "" : "中".repeat(350_000) });
      } };
    expect(await runCollection(dependencies, "2026-08-11T01:00:00Z")).toMatchObject({ inserted: 0, skipped: 2 });
    expect(repository.rows.size).toBe(0);
    available = true;
    expect(await runCollection(dependencies, "2026-08-11T01:05:00Z")).toMatchObject({ inserted: 1 });
    expect(repository.rows.has("S1")).toBe(true);
  });

  it("collects news when subscriptions fail and subscriptions when news fails", async () => {
    for (const failedSource of ["news", "wechat-articles"]) {
      const repository = new MemoryRepository(); const workflow = new MemoryWorkflow();
      await runCollection({ apiBaseUrl: "https://eastmoney.hasbai.xyz/data", repository, workflow,
        fetcher: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/" + failedSource)) return new Response("unavailable", { status: 503 });
          if (path.endsWith("/news")) return Response.json(apiPayload);
          if (path.endsWith("/wechat-articles")) return Response.json([subscribed("W1", "公众号文章")]);
          return Response.json({ content: "DM正文" });
        } }, "2026-08-11T01:00:00Z");
      expect(workflow.batches.flat()).toHaveLength(failedSource === "news" ? 1 : 2);
    }
  });

  it("keeps an earlier dispatched batch when the next batch fails", async () => {
    const repository = new MemoryRepository(); let calls = 0;
    await expect(runCollection({ apiBaseUrl: "https://eastmoney.hasbai.xyz/data", repository,
      workflow: { async start(articles) { if (++calls === 2) throw new Error("dispatch failed"); return articles.map((article) => article.id); } },
      fetcher: async (input) => Response.json(new URL(String(input)).pathname.endsWith("/wechat-articles") ? [] :
        Array.from({ length: 101 }, (_, index) => ({ ...apiPayload[0], sentimentId: `N${index}`, title: `文章${index}` }))),
    }, "2026-08-11T01:00:00Z")).rejects.toThrow("dispatch failed");
    expect(repository.rows.size).toBe(101);
    expect(repository.removed).toEqual([]);
  });

  it("does not delete a row recovered by another Cron after an earlier missing-instance observation", async () => {
    const repository = new MemoryRepository();
    const instances = new Set<string>();
    const binding = {
      async get(id: string) { return { async status() {
        if (!instances.has(id)) throw new Error("instance.not_found");
        return { status: "queued" };
      } }; },
      async createBatch(options: { id: string }[]) {
        options.forEach((option) => instances.add(option.id));
        return options.map((option) => ({ id: option.id }));
      },
    } as unknown as Env["ARTICLE_WORKFLOW"];
    const recovery = new CloudflareArticleWorkflowLauncher(binding);
    await expect(runCollection({ apiBaseUrl: "https://eastmoney.hasbai.xyz/data", repository, fetcher,
      workflow: { async start() {
        // Cron B creates the instance while Cron A still holds a stale negative.
        await recovery.reconcile([...repository.rows.values()], "https://eastmoney.hasbai.xyz/data");
        throw new WorkflowDispatchError("earlier instance.not_found", new Set());
      } },
    }, "2026-08-11T01:00:00Z")).rejects.toThrow("earlier instance.not_found");
    expect(instances).toEqual(new Set(["article-S1", "article-S2"]));
    expect(repository.rows.size).toBe(2);
    expect(repository.removed).toEqual([]);
  });
});

const longUrl = "https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1&sn=test";
function subscribed(id: string, title: string, time = "2026-08-11T09:00:00+08:00") {
  return { sentimentId: id, title, time, accountName: "关注公众号", url: longUrl };
}

describe("D1 title and Shanghai date deduplication", () => {
  beforeEach(async () => {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS article (id TEXT PRIMARY KEY, news_id TEXT, title TEXT NOT NULL, published_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, link TEXT, prompt_version TEXT)").run();
    await env.DB.prepare("DELETE FROM article").run();
  });

  it("atomically inserts one article across concurrent sources but allows the next Shanghai date", async () => {
    const repository = new D1ArticleRepository(env.DB);
    const a = { id: "A", title: "同标题", publishedAt: "2026-10-01T23:30:00Z" };
    const b = { id: "B", title: "同标题", publishedAt: "2026-10-02T12:00:00+08:00" };
    const inserted = await Promise.all([repository.insertIfAbsent([a], a.publishedAt), repository.insertIfAbsent([b], b.publishedAt)]);
    expect(inserted.flat()).toHaveLength(1);
    expect(await repository.findExisting([a, b])).toEqual(new Set(["A", "B"]));
    expect(await repository.insertIfAbsent([{ ...a, id: "C", publishedAt: "2026-10-02T16:30:00Z" }], a.publishedAt)).toHaveLength(1);
  });

  it("handles 200 candidates without exceeding D1's parameter limit and does not update existing rows", async () => {
    const repository = new D1ArticleRepository(env.DB);
    const rows = Array.from({ length: 200 }, (_, index) => ({ id: `A${index}`, title: `标题${index}`, publishedAt: "2026-10-01T10:00:00+08:00" }));
    await repository.insertIfAbsent(rows, "2026-10-01T00:00:00Z");
    expect((await repository.findExisting(rows)).size).toBe(200);
    expect(await repository.insertIfAbsent(rows, "2026-10-02T00:00:00Z")).toEqual([]);
    expect(await env.DB.prepare("SELECT DISTINCT updated_at FROM article").all()).toMatchObject({ results: [{ updated_at: "2026-10-01T00:00:00Z" }] });
  });

  it("matches historical Chinese whitespace and reconstructs undispatched subscription metadata", async () => {
    const repository = new D1ArticleRepository(env.DB);
    await env.DB.prepare("INSERT INTO article (id,title,published_at,created_at,updated_at,link) VALUES (?,?,?,?,?,?)")
      .bind("old", "　同标题\t", "2026-10-01T23:30:00Z", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", longUrl).run();
    const candidate = { id: "new", title: "同标题", publishedAt: "2026-10-02T12:00:00+08:00" };
    expect(await repository.findExisting([candidate])).toEqual(new Set(["new"]));
    expect(await repository.insertIfAbsent([candidate], candidate.publishedAt)).toEqual([]);
    expect(await repository.findPending()).toEqual([expect.objectContaining({ id: "old", source: "wechat", sourceUrl: longUrl })]);
  });
});
