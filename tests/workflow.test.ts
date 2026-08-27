/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  AI_SEARCH_POLL_INTERVAL_MS,
  AI_SEARCH_POLL_TIMEOUT_MS,
} from "../src/index";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

describe("article workflow steps", () => {
  it("keeps AI Search polling below the per-invocation subrequest limit", () => {
    const maximumStatusChecks = Math.ceil(
      AI_SEARCH_POLL_TIMEOUT_MS / AI_SEARCH_POLL_INTERVAL_MS,
    );

    // Reserve requests for the initial lookup/upload and bounded error recovery.
    expect(maximumStatusChecks + 10).toBeLessThanOrEqual(50);
  });

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
          { name: "extract article features with Responses API" },
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
          id: "workflow-step-wechat",
          title: "测试文章",
          publishedAt: "2026-08-12T01:00:00Z",
        },
      });

      await expect(instance.waitForStatus("complete")).resolves.toBeUndefined();
      await expect(
        instance.waitForStepResult({ name: "download WeChat article" }),
      ).resolves.toBeInstanceOf(ReadableStream);
      await expect(
        instance.waitForStepResult({ name: "extract article features with Responses API" }),
      ).resolves.toMatchObject({ importance: 60 });
    } finally {
      await instance.dispose();
    }
  });
});

describe("Telegram workflow steps", () => {
  it("keeps source fetch, Telegram send, and delivery recording independently retryable", async () => {
    const instanceId = "workflow-step-telegram";
    const article = {
      id: "2026082600010688293",
      title: "中国央行今日开展2395亿元7天逆回购操作",
      publishedAt: "2026-08-26T09:20:47+08:00",
    };
    const instance = await introspectWorkflowInstance(env.TELEGRAM_WORKFLOW, instanceId);

    try {
      await instance.modify(async (modifier) => {
        await modifier.mockStepResult(
          { name: "fetch central bank policy news" },
          [article],
        );
        await modifier.mockStepResult(
          { name: "find delivered Telegram notifications" },
          [],
        );
        await modifier.mockStepResult(
          { name: `send Telegram notification ${article.id}` },
          12096,
        );
        await modifier.mockStepResult(
          { name: `record Telegram delivery ${article.id}` },
          { articleId: article.id, messageId: 12096 },
        );
      });

      await env.TELEGRAM_WORKFLOW.create({ id: instanceId, params: {} });

      await expect(instance.waitForStatus("complete")).resolves.toBeUndefined();
      await expect(
        instance.waitForStepResult({ name: `send Telegram notification ${article.id}` }),
      ).resolves.toBe(12096);
      await expect(instance.getOutput()).resolves.toEqual({ matched: 1, existing: 0, sent: 1 });
    } finally {
      await instance.dispose();
    }
  });
});

function stream(value: string): ReadableStream<Uint8Array> {
  return new Blob([value]).stream();
}
