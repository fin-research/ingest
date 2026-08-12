import { describe, expect, it, vi } from "vitest";

import {
  cleanRiskDisclosureMarkdown,
  fetchWechatArticleMarkdown,
  htmlToMarkdown,
  isWechatArticleLink,
  resolveArticleContent,
} from "../src/wechat";

describe("WeChat article content", () => {
  it("recognizes only WeChat public-account links", () => {
    expect(isWechatArticleLink("https://mp.weixin.qq.com/s/example")).toBe(true);
    expect(isWechatArticleLink("https://weixin.qq.com/example")).toBe(false);
    expect(isWechatArticleLink("https://example.com/mp.weixin.qq.com")).toBe(false);
  });

  it("uses the kb js_content parser and Markdown renderer", () => {
    const markdown = htmlToMarkdown(`
      <html><body><div id="js_content">
        <p>第一段<strong>加粗</strong>。</p>
        <p><a href="https://example.com/source">来源链接</a></p>
        <p><img data-src="https://example.com/chart.png" alt="图表"></p>
      </div></body></html>
    `);
    expect(markdown).toBe("第一段加粗。\n\n来源链接");
  });

  it("cleans text links and removes the final disclosure line and everything after it", () => {
    expect(
      cleanRiskDisclosureMarkdown(
        "正文[来源](https://example.com)，详见 https://example.com/raw。\n\n"
          + "![图表](https://example.com/chart.png)\n\n风险提示：利率波动。\n\n分析师声明",
      ),
    ).toBe("正文来源，详见 。");
    expect(cleanRiskDisclosureMarkdown("正文\n\n免责声明\n\n尾注")).toBe("正文");
  });

  it("downloads and cleans WeChat Markdown before returning it", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        '<div id="js_content"><p>公众号原文。</p><p>风险因素：市场波动。</p><p>尾注</p></div>',
        { status: 200, headers: { "Content-Type": "text/html" } },
      ),
    );

    const result = await fetchWechatArticleMarkdown(
      "https://mp.weixin.qq.com/s/example",
      fetcher,
    );

    expect(result).toBe("公众号原文。");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("falls back to DM text when WeChat download fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await resolveArticleContent(
      { content: "DM 正文", link: "https://mp.weixin.qq.com/s/example" },
      async () => new Response("blocked", { status: 403 }),
    );

    expect(result).toBe("DM 正文");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
