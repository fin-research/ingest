import { describe, expect, it } from "vitest";
import { cleanArchiveMarkdown, cleanMarkdownLinksAndImages } from "../src/markdown-cleanup";
import { buildArticleMarkdown, prepareAiSearchMarkdown } from "../src/article";
import { policyArchiveDocument } from "../src/policy-archive";

describe("archive Markdown cleanup", () => {
  it("removes legacy preamble fields while preserving the title and body source citations", () => {
    const input = "# 研报标题\n\nSource: 券商\n\nPublished: 2026-09-08T00:00:00Z\n\n"
      + "URL: https://example.com/report\n\nTags: 债券\n\n---\n\n正文。\n\n"
      + "数据来源：央行\n\nSource: survey responses\n\n## Published: methodology";
    expect(cleanArchiveMarkdown(input)).toBe(
      "# 研报标题\n\n正文。\n\n数据来源：央行\n\nSource: survey responses\n\n## Published: methodology",
    );
  });

  it("accepts formatted legacy labels and CRLF without matching normal prose", () => {
    expect(cleanArchiveMarkdown("\uFEFF# 标题\r\n\r\n- **Source:** 券商\r\n__Published__: 日期\r\n\r\n正文"))
      .toBe("# 标题\n\n正文");
    expect(cleanArchiveMarkdown("# 标题\n\nSource markets differ.\n\nPublished: analysis"))
      .toBe("# 标题\n\nSource markets differ.\n\nPublished: analysis");
  });

  it("recognizes the archive envelope after a title containing literal newlines", () => {
    expect(cleanArchiveMarkdown(
      "# 标题第一行\n标题第二行\n标题第三行\n\nSource: 券商\n\nPublished: 2026-09-08\n\nURL:\n\n正文",
    )).toBe("# 标题第一行\n标题第二行\n标题第三行\n\n正文");
  });

  it("keeps nested link labels and formatting and consumes complete parenthesized destinations", () => {
    expect(cleanMarkdownLinksAndImages(
      '[**期限 [1]**](https://example.com/a_(b) "标题")与[跨行\n文字](<https://example.com/a b>)。'
      + '\n\n[![图 [一]](https://example.com/chart_(1).png)](https://example.com/report)',
    )).toBe("**期限 [1]**与跨行\n文字。");
  });

  it("removes full/collapsed/shortcut image references and definitions, preserving linked text", () => {
    expect(cleanMarkdownLinksAndImages(
      "[原文][report]、[report][]、[report]\n\n![图][img] ![img][] ![img]\n\n"
      + '[report]: https://example.com/report_(1)\n  "来源"\n[img]: /images/chart.png',
    )).toBe("原文、report、report");
  });

  it("removes empty Markdown targets, HTML images/anchors and bare/autolink URLs", () => {
    expect(cleanMarkdownLinksAndImages(
      '文字[链接]() ![图片]() <a href="https://example.com">说明</a>'
      + '<picture><source srcset="https://example.com/a"><img src="https://example.com/b"></picture>'
      + ' <https://example.com/x> https://example.com/y。',
    )).toBe("文字链接  说明  。");
  });

  it("consumes malformed WeChat links whose URL contains spaces without leaving query fragments", () => {
    expect(cleanArchiveMarkdown(
      "正文[讲话全文](https://mp.weixin.qq.com/s?exportkey=abc def ghi&part=(1))。"
      + "\n\n![图](https://example.com/image name.png)",
    )).toBe("正文讲话全文。");
  });

  it("preserves tables, numerical ranges, headings, footnote-like text and code", () => {
    const text = "# 标题\n\n| 期限 | 利率 |\n| --- | --- |\n| 1年 | 1.8% |\n\n[1] 测算区间 (1, 3)。\n\n`[示例](relative)`";
    expect(cleanArchiveMarkdown(text)).toBe(text);
  });

  it("cleans DM fallback and cached Workflow Markdown at the R2 boundary without changing feature input", () => {
    const detail = { content: "Source: 券商\nPublished: 2026-09-08\n\n正文[来源](https://example.com)。\n\n![图](a.png)" };
    const original = buildArticleMarkdown({ id: "1", title: "标题", publishedAt: "2026-09-08" }, detail);
    const archived = prepareAiSearchMarkdown(original);
    expect(original).toContain("Source:");
    expect(original).toContain("![图]");
    expect(archived).toBe("# 标题\n\n正文来源。 \n");
    expect(prepareAiSearchMarkdown(archived)).toBe(archived);
  });

  it("uses the same archive boundary for policy Markdown and keeps search metadata", () => {
    const document = policyArchiveDocument({
      sentiment_id: "1", title: "政策", published_at: "2026-09-08T00:00:00Z",
      content: "Source: 央行\nPublished: 日期\n\n政策[原文](https://example.com)。",
      departments_json: '["央行"]',
    });
    expect(document.content).toBe("# 政策\n\n政策原文。 \n");
    expect(document.metadata).toMatchObject({ type: "政策", source: "央行", published_at: "2026-09-08T00:00:00.000Z" });
  });

  it("rejects an archive made entirely of metadata and images", () => {
    expect(() => prepareAiSearchMarkdown("Source: 券商\n\n![图](a.png)")).toThrow("empty after cleaning");
  });
});
