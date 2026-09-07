import { describe, expect, it } from "vitest";
import { migrateArchiveMetadata, sameArticleContent, validateArchiveKey, readArchiveBody } from "../src/archive-migration";

describe("R2 archive migration safeguards", () => {
  it("preserves publication time and current metadata while carrying search fields", () => {
    expect(migrateArchiveMetadata({
      author: "机构", summary: "原始摘要", published_at: "2026-08-13T09:00:00+08:00",
    }, { type: 1, source: "机构", tags: "债市", importance: 72, published_at: 1234 })).toEqual({
      author: "机构", summary: "原始摘要", type: "1", source: "机构", tags: "债市",
      importance: "72", published_at: "2026-08-13T01:00:00.000Z",
    });
  });

  it("converts indexed millisecond dates and excludes internal index metadata", () => {
    expect(migrateArchiveMetadata({}, {
      published_at: 1786582800000, source: "机构", filename: "old.md", timestamp: 1,
      __ai_search_internal: { protocol: "cache" },
    })).toEqual({ source: "机构", tags: "", published_at: "2026-08-13T01:00:00.000Z" });
  });

  it("refuses missing dates, invalid dates, and oversized metadata", () => {
    expect(() => migrateArchiveMetadata({}, {})).toThrow("Missing original");
    expect(() => migrateArchiveMetadata({}, { published_at: "unknown" })).toThrow("Invalid");
    expect(() => migrateArchiveMetadata({ summary: "中".repeat(800) }, { published_at: 1 })).toThrow("2048");
  });

  it("only treats the known punctuation workaround as equivalent content", () => {
    expect(sameArticleContent("# 标题\n\n正文。后句！\n", "# 标题\n\n正文。 后句！ \n")).toBe(true);
    expect(sameArticleContent("内容1。", "内容2。 ")).toBe(false);
  });

  it("accepts known quote aliases and rejects arbitrary paths", () => {
    expect(() => validateArchiveKey("2026-09-02/债市%22魔咒%22.md", '2026-09-02/债市"魔咒".md')).not.toThrow();
    expect(() => validateArchiveKey("2026-09-02/a.md", "2026-09-02/b.md")).toThrow();
    expect(() => validateArchiveKey("a.md", "a.md")).toThrow();
  });

  it("rejects empty or over-limit downloads", async () => {
    await expect(readArchiveBody(new Blob([]).stream())).rejects.toThrow("Empty");
    await expect(readArchiveBody(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]).stream())).rejects.toThrow("exceeds");
  });
});
