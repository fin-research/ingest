/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { D1ArticleRepository, runCollection, storeArticleMetadata } from "../src/ingest";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

describe("article workflow steps", () => {
  beforeEach(async () => {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS article (id TEXT PRIMARY KEY, news_id TEXT, title TEXT NOT NULL, published_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, link TEXT, prompt_version TEXT)").run();
    await env.DB.prepare("DELETE FROM article").run();
  });
  it("archives without an AI Search binding", () => {
    expect(Object.keys(env).some(key => key.endsWith("_SEARCH"))).toBe(false);
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
      expect(await env.DB.prepare("SELECT title FROM article WHERE id = ?").bind(instanceId).first("title")).toBe("测试文章");
      await expect(
        instance.waitForStepResult({ name: "download WeChat article" }),
      ).resolves.toBeInstanceOf(ReadableStream);
      await expect(
        instance.waitForStepResult({ name: "extract article features with Responses API" }),
      ).resolves.toMatchObject({ importance: 60 });
      const archived = await env.ARTICLE_BUCKET.get("report/2026-08-12/测试文章.md");
      expect(await archived?.text()).toBe("# 测试文章\n\n公众号正文。 \n");
      expect(archived?.customMetadata).toMatchObject({
        type: "研报",
        source: "测试机构",
        tags: "货币政策预期",
        published_at: "2026-08-12T01:00:00.000Z",
      });
      const workflow = await env.ARTICLE_WORKFLOW.get(instanceId);
      expect((await workflow.status()).output).toMatchObject({
        status: "archived",
        indexing: "r2-source",
        key: "report/2026-08-12/测试文章.md",
      });
    } finally {
      await instance.dispose();
    }
  });

  it("archives subscribed DM text without downloading WeChat and retains the list long URL", async () => {
    const instanceId = "workflow-subscribed-dm";
    const instance = await introspectWorkflowInstance(env.ARTICLE_WORKFLOW, instanceId);
    const sourceUrl = "https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1&sn=test";
    try {
      await instance.modify(async (modifier) => {
        await modifier.mockStepResult({ name: "download article from DM" }, stream(JSON.stringify({
          content: "假期文字正文。", link: "https://mp.weixin.qq.com/s/unrelated",
        })));
        await modifier.mockStepResult({ name: "extract article features with Responses API" }, {
          title: "假期订阅研报", author: "关注公众号", summary: "文字研报摘要", importance: 60,
          keywords: [{ topic: "资金面", fact: "事实", interpretation: "解读", impact: "影响" }],
        });
        await modifier.mockStepResult({ name: "store article features in D1" }, { stored: true });
        await modifier.mockStepResult({ name: "associate article with recent policies" }, { matches: 0 });
      });
      await env.ARTICLE_WORKFLOW.create({ id: instanceId, params: {
        id: instanceId, title: "假期订阅研报", publishedAt: "2026-10-01T23:00:00Z",
        source: "wechat", sourceUrl,
      } });
      await instance.waitForStatus("complete");
      expect(await instance.waitForStepResult({ name: "store article metadata in D1" })).toBe(true);
      const archived = await env.ARTICLE_BUCKET.get("report/2026-10-02/假期订阅研报.md");
      expect(await archived?.text()).toBe("# 假期订阅研报\n\n假期文字正文。 \n");
      expect(await env.DB.prepare("SELECT link FROM article WHERE id = ?").bind(instanceId).first("link")).toBe(sourceUrl);
    } finally { await instance.dispose(); }
  });

  it("finishes a title-date duplicate before downloading text or calling AI", async () => {
    const article = { id: "winner", title: "并发同标题", publishedAt: "2026-10-01T10:00:00+08:00" };
    await storeArticleMetadata(env.DB, article, article.publishedAt);
    const instanceId = "duplicate-workflow";
    const instance = await introspectWorkflowInstance(env.ARTICLE_WORKFLOW, instanceId);
    try {
      // No data binding or mocked downstream steps: a duplicate must stop immediately.
      await env.ARTICLE_WORKFLOW.create({ id: instanceId, params: { ...article, id: "loser" } });
      await instance.waitForStatus("complete");
      expect((await (await env.ARTICLE_WORKFLOW.get(instanceId)).status()).output).toEqual({ articleId: "loser", status: "duplicate" });
      expect(await env.DB.prepare("SELECT id FROM article WHERE id = 'loser'").first()).toBeNull();
    } finally { await instance.dispose(); }
  });

  it.each(["", " \n\t　"])("normally skips empty text %j and retains metadata so collection does not launch it again", async (content) => {
    const instanceId = content ? "whitespace-body-workflow" : "empty-body-workflow";
    const sourceUrl = "https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1&sn=test";
    const article = { id: instanceId, title: "空正文文章", publishedAt: "2026-10-01T10:00:00+08:00", source: "wechat" as const, sourceUrl };
    const instance = await introspectWorkflowInstance(env.ARTICLE_WORKFLOW, instanceId);
    try {
      await instance.modify(async (modifier) => {
        await modifier.mockStepResult({ name: "download article from DM" }, stream(JSON.stringify({ content, link: sourceUrl })));
      });
      await env.ARTICLE_WORKFLOW.create({ id: instanceId, params: article });
      await instance.waitForStatus("complete");
      expect((await (await env.ARTICLE_WORKFLOW.get(instanceId)).status()).output).toEqual({
        articleId: article.id, status: "skipped", reason: "empty-content",
      });
      expect(await env.ARTICLE_BUCKET.get("report/2026-10-01/空正文文章.md")).toBeNull();
      expect(await env.DB.prepare("SELECT title FROM article WHERE id = ?").bind(article.id).first("title")).toBe(article.title);
      let launches = 0;
      expect(await runCollection({ apiBaseUrl: "https://eastmoney.hasbai.xyz/data", repository: new D1ArticleRepository(env.DB),
        workflow: { async start() { launches++; return []; } },
        fetcher: async (input) => Response.json(new URL(String(input)).pathname.endsWith("/news") ? [] : [{
          sentimentId: article.id, title: article.title, time: article.publishedAt, accountName: "关注公众号", url: sourceUrl,
        }]),
      })).toMatchObject({ existing: 1, workflows: 0 });
      expect(launches).toBe(0);
    } finally { await instance.dispose(); }
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
              mergePolicyIds: [],
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
            mergedPolicies: 0,
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
      const archived = await env.ARTICLE_BUCKET.get("policy/2026-09-01/房地产信贷新政.md");
      expect(await archived?.text()).toBe("# 房地产信贷新政\n\n政策正文\n");
      expect(archived?.customMetadata).toEqual({
        type: "政策", source: "中国人民银行,国家金融监督管理总局", tags: "中央政策",
        published_at: "2026-09-01T11:00:00.000Z",
      });
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
