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
          { name: "associate article with recent policies" },
          { evaluatedPolicies: 0, evaluatedArticles: 1, matches: 0 },
        );
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

describe("Policy aggregation workflow steps", () => {
  it("downloads, aggregates, stores, and then associates research reports", async () => {
    const instanceId = "policy-workflow-step";
    const evidence = [{
      id: "policy-news-1",
      title: "房地产信贷新政",
      publishedAt: "2026-09-01T19:00:00+08:00",
      discoveredAt: "2026-09-01T11:15:00.000Z",
      workflowInstanceId: instanceId,
      content: "政策正文",
    }];
    const instance = await introspectWorkflowInstance(env.POLICY_WORKFLOW, instanceId);

    try {
      await instance.modify(async (modifier) => {
        await modifier.mockStepResult(
          { name: "download central policy news" },
          stream(JSON.stringify(evidence)),
        );
        await modifier.mockStepResult(
          { name: "aggregate central policy news with Responses API" },
          {
            groups: [{
              existingPolicyId: null,
              title: "房地产信贷管理新政",
              summary: "央行与金融监管总局改革完善房地产信贷管理制度。",
              category: "real_estate",
              departments: ["中国人民银行", "国家金融监督管理总局"],
              policyDate: "2026-09-01",
              newsIds: ["policy-news-1"],
            }],
          },
        );
        await modifier.mockStepResult(
          { name: "store policy aggregation in D1" },
          {
            news: 1,
            policies: 1,
            newPolicies: 1,
            updatedPolicies: 0,
            policyIds: ["policy-id-1"],
          },
        );
        await modifier.mockStepResult(
          { name: "associate policies with existing articles" },
          { evaluatedPolicies: 1, evaluatedArticles: 2, matches: 1 },
        );
      });

      await env.POLICY_WORKFLOW.create({
        id: instanceId,
        params: { workflowInstanceId: instanceId },
      });

      await expect(instance.waitForStatus("complete")).resolves.toBeUndefined();
      await expect(
        instance.waitForStepResult({ name: "associate policies with existing articles" }),
      ).resolves.toMatchObject({ matches: 1 });
    } finally {
      await instance.dispose();
    }
  });
});

describe("Telegram workflow steps", () => {
  it("stores a new batch before sending it to Telegram", async () => {
    const instanceId = "workflow-step-telegram";
    const article = {
      id: "2026082600010688293",
      title: "中国央行：今日开展2395亿元7天逆回购操作",
      publishedAt: "2026-08-26T09:20:47+08:00",
    };
    const instance = await introspectWorkflowInstance(env.TELEGRAM_WORKFLOW, instanceId);

    try {
      await instance.modify(async (modifier) => {
        await modifier.mockStepResult(
          { name: "store Telegram notifications" },
          [article],
        );
        await modifier.mockStepResult(
          { name: "send Telegram notifications" },
          {
            stored: 1,
            sent: 1,
            alreadySent: 0,
            deliveries: [{ articleId: article.id, messageId: 12096 }],
          },
        );
      });

      await env.TELEGRAM_WORKFLOW.create({
        id: instanceId,
        params: {
          articles: [article],
          discoveredAt: "2026-08-26T01:25:00.000Z",
        },
      });

      await expect(instance.waitForStatus("complete")).resolves.toBeUndefined();
      await expect(
        instance.waitForStepResult({ name: "store Telegram notifications" }),
      ).resolves.toEqual([article]);
      await expect(
        instance.waitForStepResult({ name: "send Telegram notifications" }),
      ).resolves.toMatchObject({ stored: 1, sent: 1, alreadySent: 0 });
    } finally {
      await instance.dispose();
    }
  });
});

function stream(value: string): ReadableStream<Uint8Array> {
  return new Blob([value]).stream();
}
