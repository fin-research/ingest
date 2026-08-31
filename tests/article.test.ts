import { describe, expect, it } from "vitest";

import {
  addChinesePunctuationSpaces,
  articleObjectKey,
  buildArticleMarkdown,
  fetchCentralBankPolicyNews,
  fetchResearchReportDetail,
  fetchResearchReportList,
  prepareAiSearchMarkdown,
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
    expect(parsed).toMatchObject({ id: "2026081100010555370", newsId: "N1" });
    expect(parsed).not.toHaveProperty("sentimentId");
    expect(workflowInstanceId(parsed)).toBe("article-2026081100010555370");
    expect(articleObjectKey(parsed)).toBe("2026-08-11/信用_市场解读.md");
  });

  it("fetches only exact market commentary tags and deduplicates article ids", async () => {
    const requested: URL[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      requested.push(new URL(input.toString()));
      return Response.json({ list: [
          article,
          article,
          { ...article, sentimentId: "2", newsId: "N2", tags: ["其他"] },
      ] });
    };

    const result = await fetchResearchReportList("https://eastmoney.hasbai.xyz/data", fetcher);

    expect(result).toHaveLength(1);
    expect(requested[0]?.pathname).toBe("/data/news");
    expect(requested[0]?.searchParams.get("tag")).toBe("市场解读");
    expect(requested[0]?.searchParams.get("pageSize")).toBe("100");
    expect(requested[0]?.searchParams.get("fields")).toBe(
      "sentimentId,newsId,title,time,tags",
    );
  });

  it("fetches the policy tag and strictly matches the full-width China central bank title prefix", async () => {
    const requested: URL[] = [];
    const matchingWithColon = {
      ...article,
      sentimentId: "policy-1",
      title: "中国央行：今日开展公开市场操作",
      tags: ["经济数据&政策", "货币政策"],
    };
    const matchingWithoutColon = {
      ...matchingWithColon,
      sentimentId: "policy-2",
      title: "中国央行今日开展2395亿元7天逆回购操作",
    };
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      requested.push(new URL(input.toString()));
      return Response.json([
          matchingWithColon,
          matchingWithColon,
          matchingWithoutColon,
          { ...matchingWithColon, sentimentId: "policy-3", title: "中国央行:今日开展公开市场操作" },
          { ...matchingWithColon, sentimentId: "policy-4", title: "中国银行：今日开展公开市场操作" },
          { ...matchingWithColon, sentimentId: "policy-5", title: "【快讯】中国央行：前面有文字" },
          { ...matchingWithColon, sentimentId: "policy-6", tags: ["货币政策"] },
      ]);
    };

    const result = await fetchCentralBankPolicyNews(
      "https://eastmoney.hasbai.xyz/data",
      fetcher,
    );

    expect(result.map((item) => item.id)).toEqual(["policy-1"]);
    expect(requested[0]?.pathname).toBe("/data/news");
    expect(requested[0]?.searchParams.get("tag")).toBe("经济数据&政策");
    expect(requested[0]?.searchParams.get("pageSize")).toBe("100");
  });

  it("fetches report details by sentimentId", async () => {
    let requested = "";
    const detail = await fetchResearchReportDetail(
      "https://eastmoney.hasbai.xyz/data",
      validateArticleMetadata(article),
      async (input) => {
        requested = input.toString();
        return Response.json({ content: "完整正文。" });
      },
    );

    expect(new URL(requested).pathname).toBe("/data/news/2026081100010555370");
    expect(detail.content).toBe("完整正文。");
  });

  it("keeps R2 Markdown unchanged by the AI Search punctuation workaround", () => {
    const markdown = buildArticleMarkdown(validateArticleMetadata(article), {
      content: "第一句。第二句！\n\n第三句？",
    });
    expect(markdown).toBe("# 信用/市场解读\n\n第一句。第二句！\n\n第三句？\n");
    expect(prepareAiSearchMarkdown(markdown)).toBe(
      "# 信用/市场解读\n\n第一句。 第二句！ \n\n第三句？ \n",
    );
  });

  it("adds parser-visible Chinese punctuation spaces idempotently", () => {
    const processed = addChinesePunctuationSpaces(
      "句一，句二。句三！\n句四？　句五； 句六：分项一、分项二。",
    );

    expect(processed).toBe(
      "句一， 句二。 句三！ \n句四？　句五； 句六： 分项一、 分项二。 ",
    );
    expect(addChinesePunctuationSpaces(processed)).toBe(processed);
  });

  it("processes title punctuation only when preparing AI Search content", () => {
    const markdown = buildArticleMarkdown(
      { ...validateArticleMetadata(article), title: "标题？" },
      { content: "正文。" },
    );

    expect(markdown).toBe("# 标题？\n\n正文。\n");
    expect(prepareAiSearchMarkdown(markdown)).toBe("# 标题？ \n\n正文。 \n");
  });

  it("rejects malformed list metadata and empty detail content", async () => {
    expect(() => validateArticleMetadata({ ...article, sentimentId: "bad/id" })).toThrow(
      "unsupported",
    );
    await expect(
      fetchResearchReportDetail(
        "https://eastmoney.hasbai.xyz/data",
        validateArticleMetadata(article),
        async () => Response.json({ content: "" }),
      ),
    ).rejects.toThrow("content is required");
  });
});
