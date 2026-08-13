/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

describe("article workflow steps", () => {
  it("runs WeChat processing as a separate step after downloading DM detail", async () => {
    const instanceId = "workflow-step-wechat";
    const instance = await introspectWorkflowInstance(env.ARTICLE_WORKFLOW, instanceId);

    try {
      await instance.modify(async (modifier) => {
        await modifier.mockStepResult(
          { name: "download article from DM" },
          stream(JSON.stringify({
            content: "DM 正文",
            link: "https://mp.weixin.qq.com/s/example",
          })),
        );
        await modifier.mockStepResult(
          { name: "download WeChat article" },
          stream("# 测试文章\n\n公众号正文。\n"),
        );
        await modifier.mockStepResult(
          { name: "extract article features with Gemma 4" },
          {
            title: "测试文章",
            author: "测试机构",
            summary: "测试摘要",
            importance: 60,
            keywords: [
              {
                topic: "货币政策预期",
                fact: "原文事实",
                interpretation: "归纳含义",
                impact: "流动性预期改善可能同时影响股票估值与利率债定价。",
              },
            ],
          },
        );
        await modifier.mockStepResult({ name: "store article features in D1" }, { stored: true });
        await modifier.mockStepResult(
          { name: "store article in R2" },
          { key: "2026-08-12/测试文章.md", etag: "etag-1", size: 32 },
        );
        await modifier.mockStepResult(
          { name: "store article in AI Search" },
          { key: "2026-08-12/测试文章.md", itemId: "item-1", status: "completed" },
        );
      });

      await env.ARTICLE_WORKFLOW.create({
        id: instanceId,
        params: {
          articleId: "workflow-step-wechat",
          sentimentId: "workflow-step-wechat",
          title: "测试文章",
          publishedAt: "2026-08-12T01:00:00Z",
        },
      });

      await expect(instance.waitForStatus("complete")).resolves.toBeUndefined();
      await expect(
        instance.waitForStepResult({ name: "download WeChat article" }),
      ).resolves.toBeInstanceOf(ReadableStream);
      await expect(
        instance.waitForStepResult({ name: "extract article features with Gemma 4" }),
      ).resolves.toMatchObject({ importance: 60 });
    } finally {
      await instance.dispose();
    }
  });
});

function stream(value: string): ReadableStream<Uint8Array> {
  return new Blob([value]).stream();
}
