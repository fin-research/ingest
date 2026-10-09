import { describe, expect, it } from "vitest";
import { type ArticleMetadata, validateArticleMetadata } from "../src/article";
import { CloudflareArticleWorkflowLauncher } from "../src/ingest";

const article = { id: "A", title: "研报", publishedAt: "2026-10-01T00:00:00Z" };
class WorkflowStub {
  states = new Map<string, string>();
  batches: ArticleMetadata[][] = [];
  failCreate = false;
  async createBatch(options: { id: string; params: ArticleMetadata }[]) {
    if (this.failCreate) throw new Error("create transport failure");
    const created = options.filter((option) => !this.states.has(option.id));
    for (const option of created) this.states.set(option.id, "queued");
    this.batches.push(created.map((option) => option.params));
    return created.map((option) => ({ id: option.id }));
  }
  launcher() { return new CloudflareArticleWorkflowLauncher(this as unknown as Env["ARTICLE_WORKFLOW"]); }
}

describe("direct article workflow dispatch", () => {
  it("passes only metadata with stable IDs and launches an empty list without an API request", async () => {
    const binding = new WorkflowStub();
    expect(await binding.launcher().start([])).toEqual([]);
    expect(binding.batches).toEqual([]);
    expect(await binding.launcher().start([article])).toEqual(["article-A"]);
    expect(binding.batches).toEqual([[article]]);
  });

  it.each(["queued", "running", "errored", "terminated", "complete"])("does not query or restart existing %s instances on repeated scans", async (status) => {
    // No get/status/restart methods are available: direct dispatch must not call them.
    const binding = new WorkflowStub(); binding.states.set("article-A", status);
    const launcher = binding.launcher();
    expect(await launcher.start([article])).toEqual([]);
    expect(await launcher.start([article])).toEqual([]);
    expect(binding.states.get("article-A")).toBe(status);
  });

  it("accepts a partial createBatch response and still launches new IDs", async () => {
    const binding = new WorkflowStub(); binding.states.set("article-A", "errored");
    expect(await binding.launcher().start([article, { ...article, id: "B" }])).toEqual(["article-B"]);
    expect(binding.batches).toEqual([[{ ...article, id: "B" }]]);
  });

  it("surfaces a create transport failure without status scans or automatic recovery", async () => {
    const binding = new WorkflowStub(); binding.failCreate = true;
    await expect(binding.launcher().start([article])).rejects.toThrow("create transport failure");
  });

  it("keeps long Unicode metadata below the batch RPC byte limit without changing its contents", async () => {
    const sourceUrl = "https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1&sn=test&extra=" + "中".repeat(4000);
    const articles = Array.from({ length: 100 }, (_, index) => validateArticleMetadata({
      id: `W${index}`, title: "中".repeat(500), time: article.publishedAt, source: "wechat", sourceUrl,
    }));
    const binding = new WorkflowStub();
    expect(await binding.launcher().start(articles)).toHaveLength(100);
    expect(binding.batches.flat()).toEqual(articles);
    expect(binding.batches.length).toBeGreaterThan(1);
    for (const batch of binding.batches) {
      expect(new TextEncoder().encode(JSON.stringify(batch.map((params) => ({ id: `article-${params.id}`, params })))).byteLength).toBeLessThan(900 * 1024);
    }
  });
});
