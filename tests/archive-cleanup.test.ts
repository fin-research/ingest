import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cleanArchivedReport } from "../src/archive-cleanup";

describe("R2 archive cleanup", () => {
  async function fixture(content = "# 报告\n\nSource: 券商\n\nPublished: 2026-09-08\n\n正文[依据](https://example.com)。\n\n![图](chart.png)") {
    const key = `report/2026-09-08/${crypto.randomUUID()}.md`;
    const customMetadata = { type: "研报", published_at: "2026-09-08T00:00:00Z", source: "券商", extra: "保留" };
    const httpMetadata = { contentType: "text/markdown; charset=utf-8", cacheControl: "max-age=300" };
    const object = await env.ARTICLE_BUCKET.put(key, content, { customMetadata, httpMetadata });
    return { key, etag: object.etag, customMetadata, httpMetadata };
  }

  it("cleans the object in place, preserves all metadata and is safe to replay", async () => {
    const item = await fixture();
    expect(await cleanArchivedReport(env.ARTICLE_BUCKET, item)).toMatchObject({ key: item.key, changed: true });
    const stored = await env.ARTICLE_BUCKET.get(item.key);
    expect(await stored?.text()).toBe("# 报告\n\n正文依据。 \n");
    expect(stored?.customMetadata).toEqual(item.customMetadata);
    expect(stored?.httpMetadata).toEqual(item.httpMetadata);
    expect(await cleanArchivedReport(env.ARTICLE_BUCKET, item)).toMatchObject({ changed: false });
  });

  it("refuses a stale backup without changing the newer report", async () => {
    const item = await fixture();
    await env.ARTICLE_BUCKET.put(item.key, "# 新版\n\nSource: 新来源\n\n新增正文");
    await expect(cleanArchivedReport(env.ARTICLE_BUCKET, item)).rejects.toThrow("changed after backup");
    expect(await (await env.ARTICLE_BUCKET.get(item.key))?.text()).toContain("新增正文");
  });

  it("uses a conditional write if the object changes between reading and writing", async () => {
    const item = await fixture();
    const bucket: Pick<R2Bucket, "get" | "put"> = {
      get: env.ARTICLE_BUCKET.get.bind(env.ARTICLE_BUCKET),
      put: async (key, value, options) => {
        await env.ARTICLE_BUCKET.put(key, "并发写入");
        return await env.ARTICLE_BUCKET.put(key, value, options);
      },
    };
    await expect(cleanArchivedReport(bucket, item)).rejects.toThrow("changed during cleanup");
    expect(await (await env.ARTICLE_BUCKET.get(item.key))?.text()).toBe("并发写入");
  });

  it("flags image-only reports and retains their title", async () => {
    const item = await fixture("# 图表报告\n\nSource: 券商\n\n![图](chart.png)");
    expect(await cleanArchivedReport(env.ARTICLE_BUCKET, item)).toMatchObject({ changed: true, titleOnly: true });
    expect(await (await env.ARTICLE_BUCKET.get(item.key))?.text()).toBe("# 图表报告\n");
  });

  it("rejects other prefixes and missing objects", async () => {
    await expect(cleanArchivedReport(env.ARTICLE_BUCKET, { key: "policy/2026-09-08/a.md", etag: "a".repeat(32) })).rejects.toThrow();
    await expect(cleanArchivedReport(env.ARTICLE_BUCKET, { key: "report/2026-09-08/missing.md", etag: "a".repeat(32) })).rejects.toThrow("Missing");
  });
});
