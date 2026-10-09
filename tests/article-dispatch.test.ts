import { describe, expect, it } from "vitest";
import { type ArticleWorkflowParams } from "../src/article";
import { CloudflareArticleWorkflowLauncher, WorkflowDispatchError } from "../src/ingest";

const article = { id: "A", title: "订阅文字研报", publishedAt: "2026-10-01T00:00:00Z",
  source: "wechat" as const, sourceUrl: "https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1&sn=test" };

class WorkflowStub {
  states = new Map<string, string>();
  batches: ArticleWorkflowParams[][] = [];
  failCreate = false;
  failStatus = false;
  failRestart = false;
  restarts = 0;
  async createBatch(options: { id: string; params: ArticleWorkflowParams }[]) {
    if (this.failCreate) throw new Error("create transport failure");
    const created = options.filter((option) => !this.states.has(option.id));
    for (const option of created) this.states.set(option.id, "queued");
    this.batches.push(created.map((option) => option.params));
    return created.map((option) => ({ id: option.id }));
  }
  async get(id: string) {
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
    expect(await binding.launcher().start([{ ...article, subscriptionContent: "正文" }])).toEqual(["article-A"]);
    expect(binding.restarts).toBe(1);
    expect(binding.batches).toEqual([[]]);
  });

  it("retains confirmed active instances and releases only confirmed missing IDs after partial failure", async () => {
    const binding = new WorkflowStub(); binding.states.set("article-A", "running"); binding.failCreate = true;
    const params = [{ ...article, subscriptionContent: "正文" }, { ...article, id: "B", subscriptionContent: "另一篇正文" }];
    await expect(binding.launcher().start(params)).rejects.toMatchObject({ retainedArticleIds: new Set(["A"]) });
  });

  it("accepts a lost create response when every instance is confirmed active", async () => {
    const binding = new WorkflowStub(); binding.states.set("article-A", "running"); binding.failCreate = true;
    expect(await binding.launcher().start([{ ...article, subscriptionContent: "正文" }])).toEqual(["article-A"]);
  });

  it.each(["terminated", "unknown", "errored"])("does not report %s or a failed restart as successful dispatch", async (status) => {
    const binding = new WorkflowStub(); binding.states.set("article-A", status); binding.failRestart = true;
    const launcher = binding.launcher();
    await expect(launcher.start([{ ...article, subscriptionContent: "正文" }])).rejects.toMatchObject({ retainedArticleIds: new Set(["A"]) });
    binding.failRestart = false;
    await launcher.reconcile([article], "https://eastmoney.hasbai.xyz/data");
    expect(binding.restarts).toBe(status === "errored" ? 1 : 0);
  });
});
