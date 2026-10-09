import { describe, expect, it } from "vitest";
import { type ArticleWorkflowParams } from "../src/article";
import { articleDispatchBatches, rotatingSlice, CloudflareArticleWorkflowLauncher, WorkflowDispatchError } from "../src/ingest";

const article = { id: "A", title: "订阅文字研报", publishedAt: "2026-10-01T00:00:00Z",
  source: "wechat" as const, sourceUrl: "https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1&sn=test" };

class WorkflowStub {
  states = new Map<string, string>();
  batches: ArticleWorkflowParams[][] = [];
  failCreate = false;
  failStatus = false;
  failRestart = false;
  restarts = 0;
  getCalls = 0;
  async create(option: { id: string; params: ArticleWorkflowParams }) {
    const created = await this.createBatch([option]);
    if (!created[0]) throw new Error("instance already exists");
    return created[0];
  }
  async createBatch(options: { id: string; params: ArticleWorkflowParams }[]) {
    if (this.failCreate) throw new Error("create transport failure");
    const created = options.filter((option) => !this.states.has(option.id));
    for (const option of created) this.states.set(option.id, "queued");
    this.batches.push(created.map((option) => option.params));
    return created.map((option) => ({ id: option.id }));
  }
  async get(id: string) {
    this.getCalls++;
    return { id,
      status: async () => {
        if (this.failStatus) throw new Error("status transport failure");
        if (!this.states.has(id)) throw new Error("instance.not_found");
        return { status: this.states.get(id) };
      },
      restart: async () => {
        if (this.failRestart) throw new Error("restart failed");
        this.restarts++; this.states.set(id, "queued");
      },
    };
  }
  launcher() { return new CloudflareArticleWorkflowLauncher(this as unknown as Env["ARTICLE_WORKFLOW"]); }
}

describe("article dispatch reconciliation", () => {
  it("bounds each recovery scan and rotates beyond old running records", () => {
    const rows = Array.from({ length: 43 }, (_, index) => index);
    const seen = new Set<number>();
    for (let index = 0; index < 43; index++) {
      const selected = rotatingSlice(rows, 5, new Date(Date.UTC(2026, 9, 9, 0, index * 5)).toISOString());
      expect(selected).toHaveLength(5); selected.forEach((value) => seen.add(value));
    }
    expect(seen.size).toBe(43);
  });
  it("splits by total UTF-8 RPC bytes as well as count and preserves each full text", () => {
    const rows = Array.from({ length: 42 }, (_, index) => ({ ...article, id: String(index), subscriptionContent: "中".repeat(20_000) }));
    const batches = articleDispatchBatches(rows);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(rows);
    for (const batch of batches) expect(new TextEncoder().encode(JSON.stringify(batch.map((params) => ({ id: `article-${params.id}`, params })))).byteLength).toBeLessThan(900 * 1024);
    expect(articleDispatchBatches(Array.from({ length: 101 }, (_, index) => ({ ...article, id: String(index) }))).map((batch) => batch.length)).toEqual([100, 1]);
  });
  it("recovers an uncertain creation on the next scan, including an article outside the current list", async () => {
    const binding = new WorkflowStub(); binding.failCreate = true; binding.failStatus = true;
    const launcher = binding.launcher();
    let error: unknown;
    try { await launcher.start([{ ...article, subscriptionContent: "已校验快照" }]); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(WorkflowDispatchError);
    expect((error as WorkflowDispatchError).retainedArticleIds).toEqual(new Set(["A"]));
    binding.failCreate = false; binding.failStatus = false;
    await launcher.reconcile([article], "https://eastmoney.hasbai.xyz/data", async () => Response.json({ content: "恢复的DM正文", link: "https://example.com/wrong" }));
    expect(binding.batches).toEqual([[{ ...article, subscriptionContent: "恢复的DM正文" }]]);
  });

  it("restarts silently skipped errored instances without replacing their original payload", async () => {
    const binding = new WorkflowStub(); binding.states.set("article-A", "errored");
    const launcher = binding.launcher();
    await expect(launcher.start([{ ...article, subscriptionContent: "正文" }])).rejects.toBeInstanceOf(WorkflowDispatchError);
    await launcher.reconcile([article], "https://eastmoney.hasbai.xyz/data");
    expect(binding.restarts).toBe(1);
    expect(binding.batches).toEqual([[]]);
  });

  it("retains the whole batch after uncertain creation without spending status requests", async () => {
    const binding = new WorkflowStub(); binding.states.set("article-A", "running"); binding.failCreate = true;
    const params = [{ ...article, subscriptionContent: "正文" }, { ...article, id: "B", subscriptionContent: "另一篇正文" }];
    await expect(binding.launcher().start(params)).rejects.toMatchObject({ retainedArticleIds: new Set(["A", "B"]) });
    expect(binding.getCalls).toBe(0);
  });

  it("confirms a lost create response during the next bounded reconciliation", async () => {
    const binding = new WorkflowStub(); binding.states.set("article-A", "running"); binding.failCreate = true;
    const launcher = binding.launcher();
    await expect(launcher.start([{ ...article, subscriptionContent: "正文" }])).rejects.toBeInstanceOf(WorkflowDispatchError);
    await launcher.reconcile([article], "https://eastmoney.hasbai.xyz/data");
    expect(binding.states.get("article-A")).toBe("running");
  });

  it.each(["terminated", "unknown", "errored"])("does not report %s or a failed restart as successful dispatch", async (status) => {
    const binding = new WorkflowStub(); binding.states.set("article-A", status); binding.failRestart = true;
    const launcher = binding.launcher();
    await expect(launcher.start([{ ...article, subscriptionContent: "正文" }])).rejects.toMatchObject({ retainedArticleIds: new Set(["A"]) });
    binding.failRestart = false;
    await launcher.reconcile([article], "https://eastmoney.hasbai.xyz/data");
    expect(binding.restarts).toBe(status === "errored" ? 1 : 0);
  });

  it("bounds actual reconciliation to five candidates and does not inspect 100 IDs on creation error", async () => {
    const binding = new WorkflowStub();
    const rows = Array.from({ length: 100 }, (_, index) => ({ ...article, id: String(index), subscriptionContent: "正文" }));
    for (const row of rows) binding.states.set(`article-${row.id}`, "running");
    await binding.launcher().reconcile(rows, "https://eastmoney.hasbai.xyz/data");
    expect(binding.getCalls).toBe(5);
    binding.getCalls = 0; binding.failCreate = true;
    await expect(binding.launcher().start(rows)).rejects.toBeInstanceOf(WorkflowDispatchError);
    expect(binding.getCalls).toBe(0);
  });
});
