import { describe, expect, it } from "vitest";

import {
  addSentenceBoundarySpaces,
  articleObjectKey,
  buildArticleMarkdown,
  fetchResearchReportDetail,
  fetchResearchReportList,
  validateArticleMetadata,
  workflowInstanceId,
} from "../src/article";

const article = {
  sentimentId: "2026081100010555370",
  newsId: "N1",
  title: "信用/市场解读",
  time: "2026-08-10T17:30:00Z",
  tags: ["市场解读", "信用债"],
};

describe("research report helpers", () => {
  it("validates metadata and builds stable workflow and R2 identities", () => {
    const parsed = validateArticleMetadata(article);
    expect(workflowInstanceId(parsed)).toBe("article-2026081100010555370");
    expect(articleObjectKey(parsed)).toBe("2026-08-11/信用_市场解读.md");
  });

  it("fetches only exact market commentary tags and deduplicates article ids", async () => {
    const requested: URL[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      requested.push(new URL(input.toString()));
      return Response.json({
        list: [
          article,
          article,
          { ...article, sentimentId: "2", newsId: "N2", tags: ["其他"] },
        ],
      });
    };

    const result = await fetchResearchReportList("https://eastmoney.hasbai.xyz/api", fetcher);

    expect(result).toHaveLength(1);
    expect(requested[0]?.pathname).toBe("/api/news");
    expect(requested[0]?.searchParams.get("tag")).toBe("市场解读");
    expect(requested[0]?.searchParams.get("pageSize")).toBe("100");
  });

  it("fetches report details by newsId", async () => {
    let requested = "";
    const detail = await fetchResearchReportDetail(
      "https://eastmoney.hasbai.xyz/api",
      validateArticleMetadata(article),
      async (input) => {
        requested = input.toString();
        return Response.json({ content: "完整正文。" });
      },
    );

    expect(new URL(requested).pathname).toBe("/api/news/N1");
    expect(detail.content).toBe("完整正文。");
  });

  it("builds the exact Markdown document with Chinese sentence spacing", () => {
    const markdown = buildArticleMarkdown(validateArticleMetadata(article), {
      content: "第一句。第二句！\n\n第三句？",
    });
    expect(markdown).toBe("# 信用/市场解读\n\n第一句。 第二句！ \n\n第三句？ \n");
  });

  it("adds parser-visible Chinese sentence spaces idempotently", () => {
    const processed = addSentenceBoundarySpaces("句一。句二！\n句三？　句四； 句五。");

    expect(processed).toBe("句一。 句二！ \n句三？　句四； 句五。 ");
    expect(addSentenceBoundarySpaces(processed)).toBe(processed);
  });

  it("processes Chinese sentence punctuation in the title as part of the document", () => {
    const markdown = buildArticleMarkdown(
      { ...validateArticleMetadata(article), title: "标题？" },
      { content: "正文。" },
    );

    expect(markdown).toBe("# 标题？ \n\n正文。 \n");
  });

  it("rejects malformed list metadata and empty detail content", async () => {
    expect(() => validateArticleMetadata({ ...article, sentimentId: "bad/id" })).toThrow(
      "unsupported",
    );
    await expect(
      fetchResearchReportDetail(
        "https://eastmoney.hasbai.xyz/api",
        validateArticleMetadata(article),
        async () => Response.json({ content: "" }),
      ),
    ).rejects.toThrow("content is required");
  });
});
