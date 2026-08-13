import { describe, expect, it } from "vitest";

import {
  buildAiSearchMetadata,
  buildFeatureInferenceRequest,
  extractArticleFeatures,
  validateArticleFeatures,
} from "../src/feature-extraction";

const validFeatures = {
  title: "债市如何定价降准降息？",
  author: "国海固收",
  summary: "研报讨论宽松政策的条件与约束，并提示利率债定价需等待关键外部条件验证。",
  importance: 72,
  keywords: [
    {
      topic: "降准降息预期",
      fact: "研报认为基本面与银行息差约束减弱，宽松预期有合理性。",
      interpretation: "政策宽松概率上升，但落地时点仍有不确定性。",
      impact: "流动性改善预期可能提振股票估值并利多利率债，但债券定价需防范宽松预期抢跑。",
    },
  ],
};

describe("article feature extraction", () => {
  it("uses the stable Gemma parameters without truncating Markdown", () => {
    const markdown = "中".repeat(100_000);
    const request = buildFeatureInferenceRequest("标题", markdown);

    expect(request.temperature).toBe(0.1);
    expect(request.top_p).toBe(0.85);
    expect(request.reasoning_effort).toBe("low");
    expect(request.chat_template_kwargs.enable_thinking).toBe(false);
    expect(request.max_completion_tokens).toBe(4_000);
    expect(request.messages[0]?.content).toContain("输出“国海固收”");
    expect(request.messages[0]?.content).toContain("若初步概括仍属于这类上位词");
    expect(request.messages[0]?.content).toContain("不要套用“权益：……；利率债：……”");
    expect(request.messages[1]?.content).toContain(markdown);
    expect(request.messages[1]?.content).not.toContain("权益：影响；利率债：影响");
    expect(request.messages[1]?.content).not.toContain("中间部分已省略");
  });

  it("rejects a response that reached the output token limit", async () => {
    await expect(
      extractArticleFeatures(
        async () => ({
          choices: [{ finish_reason: "length", message: { content: JSON.stringify(validFeatures) } }],
        }),
        validFeatures.title,
        "正文",
      ),
    ).rejects.toThrow("output limit");
  });

  it("parses a Workers AI chat completion and preserves the source title", async () => {
    const extracted = await extractArticleFeatures(
      async () => ({
        choices: [{ message: { content: JSON.stringify({ ...validFeatures, title: "模型改写标题" }) } }],
      }),
      validFeatures.title,
      "正文",
    );

    expect(extracted).toEqual(validFeatures);
  });

  it("rejects invalid importance and duplicate topics without enforcing topic wording", () => {
    expect(() =>
      validateArticleFeatures({ ...validFeatures, importance: 101 }, validFeatures.title),
    ).toThrow("importance");
    expect(() =>
      validateArticleFeatures(
        { ...validFeatures, keywords: [validFeatures.keywords[0], validFeatures.keywords[0]] },
        validFeatures.title,
      ),
    ).toThrow("unique");
    expect(
      validateArticleFeatures(
        {
          ...validFeatures,
          keywords: [{ ...validFeatures.keywords[0], topic: "货币政策预期" }],
        },
        validFeatures.title,
      ).keywords[0]?.topic,
    ).toBe("货币政策预期");
  });

  it("builds AI Search metadata from extracted features", () => {
    const features = {
      ...validFeatures,
      keywords: [
        validFeatures.keywords[0],
        { ...validFeatures.keywords[0], topic: "隔夜逆回购重启" },
      ],
    };

    expect(buildAiSearchMetadata(features, "2026-08-13T01:02:03Z")).toEqual({
      source: "国海固收",
      tags: "降准降息预期,隔夜逆回购重启",
      importance: "72",
      published_at: "2026-08-13T01:02:03.000Z",
    });
  });
});
