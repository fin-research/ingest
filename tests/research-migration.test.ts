import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { policyArchiveDocument } from "../src/policy-archive";

describe("research archive migration", () => {
  it("copies and verifies before removing a report source, preserving its date and body", async () => {
    const key = "2026-08-01/迁移校验.md";
    const content = "# 原文\n\n正文。 \n";
    const metadata = { type: "1", source: "测试机构", published_at: "2026-08-01T01:00:00.000Z" };
    const object = await env.ARTICLE_BUCKET.put(key, content, { customMetadata: metadata });
    for (const action of ["copy", "cleanup"] as const) {
      const id = `research-migration-${action}`;
      const instance = await introspectWorkflowInstance(env.ARCHIVE_MIGRATION_WORKFLOW, id);
      try {
        await env.ARCHIVE_MIGRATION_WORKFLOW.create({ id, params: {
          migration: "research", action, reports: [{ key, etag: object!.etag, metadata }], policies: [],
        } });
        await instance.waitForStatus("complete");
        const target = await env.ARTICLE_BUCKET.get(`report/${key}`);
        expect(await target?.text()).toBe(content);
        expect(target?.customMetadata).toEqual({ ...metadata, type: "研报" });
        expect(Boolean(await env.ARTICLE_BUCKET.head(key))).toBe(action === "copy");
      } finally { await instance.dispose(); }
    }
  });

  it("refuses to remove the source when the destination body differs", async () => {
    const key = "2026-08-01/迁移冲突.md";
    const metadata = { published_at: "2026-08-01T01:00:00.000Z" };
    const source = await env.ARTICLE_BUCKET.put(key, "完整原文", { customMetadata: metadata });
    await env.ARTICLE_BUCKET.put(`report/${key}`, "另一篇正文", { customMetadata: { ...metadata, type: "研报" } });
    const id = "research-migration-conflict";
    const instance = await introspectWorkflowInstance(env.ARCHIVE_MIGRATION_WORKFLOW, id);
    try {
      await env.ARCHIVE_MIGRATION_WORKFLOW.create({ id, params: {
        migration: "research", action: "cleanup", reports: [{ key, etag: source!.etag, metadata }], policies: [],
      } });
      await instance.waitForStatus("errored");
      expect(await (await env.ARTICLE_BUCKET.get(key))?.text()).toBe("完整原文");
    } finally { await instance.dispose(); }
  });

  it("archives policy text with its Shanghai date and textual type", () => {
    const document = policyArchiveDocument({ sentiment_id: "policy1", title: "新政",
      published_at: "2026-08-31T17:00:00Z", content: "原文。下一句。",
      departments_json: '["财政部"]',
    });
    expect(document.key).toBe("policy/2026-09-01/新政.md");
    expect(document.content).toBe("# 新政\n\n原文。 下一句。 \n");
    expect(document.metadata).toEqual({ type: "政策", source: "财政部", tags: "中央政策", published_at: "2026-08-31T17:00:00.000Z" });
  });
});
