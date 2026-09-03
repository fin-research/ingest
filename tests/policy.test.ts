/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArticleMetadata } from "../src/article";
import {
  D1PolicyNewsRepository,
  generateArticlePolicyMatches,
  generatePolicyAggregation,
  generatePolicyArticleMatches,
  POLICY_ASSOCIATION_CONCURRENCY,
  POLICY_ASSOCIATION_PROMPT_VERSION,
  POLICY_PROMPT_VERSION,
  policyWorkflowInstanceId,
  runPolicyCollection,
  type PolicyAggregationCandidate,
  type PolicyAggregationResult,
  type PolicyArticleEvidence,
  type PolicyNewsEvidence,
  type PolicyNewsRepository,
  type PolicyNewsRow,
  type PolicyWorkflowLauncher,
  type PolicyWorkflowSummary,
} from "../src/policy";

const apiRows = [
  {
    sentimentId: "policy-1",
    newsId: "news-1",
    title: "中国央行、金融监管总局印发房地产信贷管理意见",
    time: "2026-09-01T19:00:00+08:00",
    tags: ["中央政策", "房地产"],
  },
  {
    sentimentId: "policy-2",
    newsId: "news-2",
    title: "个人住房贷款期限最长延长至40年",
    time: "2026-09-01T19:10:00+08:00",
    tags: ["中央政策", "房地产"],
  },
];

class MemoryPolicyRepository implements PolicyNewsRepository {
  claimed = false;
  released = false;

  async queueAndClaim(
    articles: ArticleMetadata[],
    workflowInstanceId: string,
    discoveredAt: string,
  ): Promise<PolicyNewsRow[]> {
    if (this.claimed) return [];
    this.claimed = true;
    return articles.map((article) => ({
      ...article,
      discoveredAt,
      workflowInstanceId,
    }));
  }

  async releaseClaim(): Promise<void> {
    this.released = true;
    this.claimed = false;
  }

  async loadClaimed(): Promise<PolicyNewsRow[]> {
    return [];
  }

  async loadRecentPolicies(): Promise<PolicyAggregationCandidate[]> {
    return [];
  }

  async saveAggregation(
    _workflowInstanceId: string,
    _evidence: PolicyNewsEvidence[],
    _aggregation: PolicyAggregationResult,
    _savedAt: string,
  ): Promise<PolicyWorkflowSummary> {
    throw new Error("not used by collector test");
  }
}

class MemoryPolicyWorkflow implements PolicyWorkflowLauncher {
  ids: string[] = [];

  async start(workflowInstanceId: string): Promise<string> {
    this.ids.push(workflowInstanceId);
    return workflowInstanceId;
  }
}

describe("central policy collection", () => {
  it("claims exact central-policy news and starts one aggregation workflow", async () => {
    const repository = new MemoryPolicyRepository();
    const workflow = new MemoryPolicyWorkflow();
    const dependencies = {
      apiBaseUrl: "https://eastmoney.hasbai.xyz/data",
      repository,
      workflow,
      fetcher: async (): Promise<Response> => Response.json(apiRows),
    };

    const first = await runPolicyCollection(dependencies, "2026-09-01T11:15:00Z");
    const second = await runPolicyCollection(dependencies, "2026-09-01T11:20:00Z");

    expect(first).toEqual({ fetched: 2, claimed: 2, workflows: 1 });
    expect(second).toEqual({ fetched: 2, claimed: 0, workflows: 0 });
    expect(workflow.ids).toEqual(["policy-1788261300000"]);
  });

  it("releases claimed news when Workflow dispatch fails", async () => {
    const repository = new MemoryPolicyRepository();

    await expect(runPolicyCollection(
      {
        apiBaseUrl: "https://eastmoney.hasbai.xyz/data",
        repository,
        workflow: {
          async start(): Promise<string> {
            throw new Error("workflow unavailable");
          },
        },
        fetcher: async (): Promise<Response> => Response.json(apiRows),
      },
      "2026-09-01T11:15:00Z",
    )).rejects.toThrow("workflow unavailable");

    expect(repository.released).toBe(true);
  });

  it("uses a stable Workflow identity derived from the Cron timestamp", () => {
    expect(policyWorkflowInstanceId("2026-09-01T11:15:00Z")).toBe(
      "policy-1788261300000",
    );
  });
});

describe("policy package aggregation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defines the four 828 real-estate documents as one policy event", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const titles = [
      "《商品住房开发贷款管理办法（试行）》",
      "《关于改革完善房地产信贷管理推动加快构建房地产发展新模式的意见》",
      "《关于资本市场支持构建房地产发展新模式的意见》",
      "《关于完善商品住房销售制度的通知》",
    ];
    const evidence = titles.map((title, index) => ({
      id: `828-${index + 1}`,
      title,
      publishedAt: `2026-08-28T19:0${index}:00+08:00`,
      discoveredAt: "2026-08-28T11:10:00.000Z",
      workflowInstanceId: "policy-828",
      content: `${title}围绕构建房地产发展新模式作出配套制度安排。`,
    }));
    const requests: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responsesOutput({
        groups: [{
          existingPolicyId: null,
          mergePolicyIds: [],
          title: "828房地产政策",
          summary: "多部门于8月28日集中发布房地产信贷、融资、资本市场和商品住房销售配套制度，共同推动构建房地产发展新模式。",
          category: "real_estate",
          departments: ["中国人民银行", "国家金融监督管理总局", "中国证监会", "住房城乡建设部"],
          policyDate: "2026-08-28",
          newsIds: evidence.map((item) => item.id),
        }],
      });
    };

    const result = await generatePolicyAggregation(
      { accountId: "account", gatewayId: "default", token: "token" },
      evidence,
      [],
      fetcher,
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.title).toBe("828房地产政策");
    expect(result.groups[0]?.newsIds).toEqual(evidence.map((item) => item.id));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt_cache_key).toBe(`policy-tracking:${POLICY_PROMPT_VERSION}`);
    expect(requests[0]?.instructions).toContain("按“政策事件/政策包”而不是按“文件篇数”聚合");
    for (const title of titles) expect(requests[0]?.instructions).toContain(title);
    const input = requests[0]?.input as Array<{ content: string }>;
    const prompt = JSON.parse(input[0]?.content ?? "null") as {
      pendingNews: Array<{ publishedDateShanghai: string }>;
    };
    expect(prompt.pendingNews.map((item) => item.publishedDateShanghai)).toEqual([
      "2026-08-28",
      "2026-08-28",
      "2026-08-28",
      "2026-08-28",
    ]);
  });

  it("allows fragmented existing cards to consolidate into an umbrella card", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const existingPolicies: PolicyAggregationCandidate[] = [
      policyCandidate("umbrella", "“828”房地产发展新模式政策包", false),
      policyCandidate("credit", "《关于改革完善房地产信贷管理推动加快构建房地产发展新模式的意见》", false),
      policyCandidate("financing", "《商品住房开发贷款管理办法（试行）》等房地产融资管理办法", false),
      policyCandidate("capital", "《关于资本市场支持构建房地产发展新模式的意见》", false),
      policyCandidate("sales", "《关于完善商品住房销售制度的通知》", false),
    ];
    const evidence = [{
      id: "other-news",
      title: "另一项中央政策",
      publishedAt: "2026-09-02T10:00:00+08:00",
      discoveredAt: "2026-09-02T02:05:00.000Z",
      workflowInstanceId: "policy-other",
      content: "这是一项与房地产政策包无关、应当独立建卡的中央政策正文。",
    }];
    const fetcher: typeof fetch = async () => responsesOutput({
      groups: [
        {
          existingPolicyId: "umbrella",
          mergePolicyIds: ["credit", "financing", "capital", "sales"],
          title: "828房地产政策",
          summary: "多部门于8月28日集中发布房地产信贷、融资、资本市场和住房销售制度，共同推动构建房地产发展新模式。",
          category: "real_estate",
          departments: ["中国人民银行", "国家金融监督管理总局", "中国证监会", "住房城乡建设部"],
          policyDate: "2026-08-28",
          newsIds: [],
        },
        {
          existingPolicyId: null,
          mergePolicyIds: [],
          title: "另一项中央政策安排",
          summary: "该项中央政策具有独立的政策目标、发布安排和实施内容，应当单独建立政策事件卡片。",
          category: "other",
          departments: ["国务院有关部门"],
          policyDate: "2026-09-02",
          newsIds: ["other-news"],
        },
      ],
    });

    const result = await generatePolicyAggregation(
      { accountId: "account", gatewayId: "default", token: "token" },
      evidence,
      existingPolicies,
      fetcher,
    );

    expect(result.groups[0]).toMatchObject({
      existingPolicyId: "umbrella",
      mergePolicyIds: ["credit", "financing", "capital", "sales"],
      newsIds: [],
    });
    expect(result.groups[1]?.newsIds).toEqual(["other-news"]);
  });

  it("moves fragment evidence and AI article links while preserving cumulative metadata", async () => {
    await createPolicyMergeTestTables();
    const canonicalId = "test-828-umbrella";
    const fragmentId = "test-828-credit";
    const workflowInstanceId = "test-policy-workflow";
    const createdAt = "2026-08-28T09:00:00.000Z";
    const insertPolicy = env.DB.prepare(`
      INSERT INTO policy_event (
        id, title, summary, category, departments_json, policy_date,
        first_news_at, last_news_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'real_estate', ?, '2026-08-28', ?, ?, ?, ?)
    `);
    await env.DB.batch([
      insertPolicy.bind(
        canonicalId,
        "“828”房地产发展新模式政策包",
        "房地产政策包总览摘要。",
        JSON.stringify(["中国证监会"]),
        "2026-08-28T21:00:00+08:00",
        "2026-08-28T21:00:00+08:00",
        createdAt,
        createdAt,
      ),
      insertPolicy.bind(
        fragmentId,
        "房地产信贷管理意见",
        "房地产信贷管理摘要。",
        JSON.stringify(["中国人民银行", "国家金融监督管理总局"]),
        "2026-08-28T19:00:00+08:00",
        "2026-08-28T19:30:00+08:00",
        createdAt,
        createdAt,
      ),
    ]);
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO policy_news (
          sentiment_id, policy_id, title, published_at, aggregation_status,
          workflow_instance_id, discovered_at, updated_at
        ) VALUES ('test-overview-news', ?, '828房地产政策总览',
          '2026-08-28T21:00:00+08:00', 'grouped', NULL, ?, ?)
      `).bind(canonicalId, createdAt, createdAt),
      env.DB.prepare(`
        INSERT INTO policy_news (
          sentiment_id, policy_id, title, published_at, aggregation_status,
          workflow_instance_id, discovered_at, updated_at
        ) VALUES ('test-credit-news', ?, '房地产信贷管理意见',
          '2026-08-28T19:00:00+08:00', 'grouped', NULL, ?, ?)
      `).bind(fragmentId, createdAt, createdAt),
      env.DB.prepare(`
        INSERT INTO policy_news (
          sentiment_id, policy_id, title, published_at, aggregation_status,
          workflow_instance_id, discovered_at, updated_at
        ) VALUES ('test-pending-news', NULL, '房地产政策配套答问',
          '2026-08-28T21:10:00+08:00', 'pending', ?, ?, ?)
      `).bind(workflowInstanceId, createdAt, createdAt),
      env.DB.prepare(`
        INSERT INTO article (id, title, published_at)
        VALUES ('test-policy-article', '房地产政策解读', '2026-08-29T09:00:00+08:00')
      `),
      env.DB.prepare(`
        INSERT INTO policy_article (
          policy_id, article_id, relation_status, association_method,
          created_at, updated_at
        ) VALUES (?, 'test-policy-article', 'linked', 'ai', ?, ?)
      `).bind(fragmentId, createdAt, createdAt),
    ]);
    const evidence: PolicyNewsEvidence[] = [{
      id: "test-pending-news",
      title: "房地产政策配套答问",
      publishedAt: "2026-08-28T21:10:00+08:00",
      discoveredAt: createdAt,
      workflowInstanceId,
      content: "多部门对828房地产政策作出配套说明。",
    }];

    const summary = await new D1PolicyNewsRepository(env.DB).saveAggregation(
      workflowInstanceId,
      evidence,
      {
        groups: [{
          existingPolicyId: canonicalId,
          mergePolicyIds: [fragmentId],
          title: "828房地产政策",
          summary: "多部门于8月28日集中发布房地产信贷、资本市场和销售制度安排，共同推动构建房地产发展新模式。",
          category: "real_estate",
          departments: ["住房城乡建设部"],
          policyDate: "2026-08-28",
          newsIds: ["test-pending-news"],
        }],
      },
      "2026-09-02T06:00:00.000Z",
    );

    expect(summary).toMatchObject({
      news: 1,
      policies: 1,
      newPolicies: 0,
      updatedPolicies: 1,
      mergedPolicies: 1,
      policyIds: [canonicalId],
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM policy_event WHERE id = ?",
    ).bind(fragmentId).first<number>("count")).toBe(0);
    const canonical = await env.DB.prepare(`
      SELECT title, departments_json, first_news_at, last_news_at
      FROM policy_event WHERE id = ?
    `).bind(canonicalId).first<{
      title: string;
      departments_json: string;
      first_news_at: string;
      last_news_at: string;
    }>();
    expect(canonical?.title).toBe("828房地产政策");
    expect(JSON.parse(canonical?.departments_json ?? "[]")).toEqual([
      "住房城乡建设部",
      "中国证监会",
      "中国人民银行",
      "国家金融监督管理总局",
    ]);
    expect(canonical?.first_news_at).toBe("2026-08-28T19:00:00+08:00");
    expect(canonical?.last_news_at).toBe("2026-08-28T21:10:00+08:00");
    const news = await env.DB.prepare(`
      SELECT sentiment_id FROM policy_news WHERE policy_id = ? ORDER BY sentiment_id
    `).bind(canonicalId).all<{ sentiment_id: string }>();
    expect(news.results.map((row) => row.sentiment_id)).toEqual([
      "test-credit-news",
      "test-overview-news",
      "test-pending-news",
    ]);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM policy_article
      WHERE policy_id = ? AND article_id = 'test-policy-article'
    `).bind(canonicalId).first<number>("count")).toBe(1);
  });

  it("rejects automatic deletion of a manually curated policy fragment", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return responsesOutput({
        groups: [{
          existingPolicyId: "umbrella",
          mergePolicyIds: ["manual-fragment"],
          title: "828房地产政策",
          summary: "多部门集中发布房地产政策，但人工维护的卡片不能作为自动合并后删除的来源卡片。",
          category: "real_estate",
          departments: ["中国人民银行"],
          policyDate: "2026-08-28",
          newsIds: ["828-follow-up"],
        }],
      });
    };

    await expect(generatePolicyAggregation(
      { accountId: "account", gatewayId: "default", token: "token" },
      [{
        id: "828-follow-up",
        title: "828房地产政策答问",
        publishedAt: "2026-08-28T21:30:00+08:00",
        discoveredAt: "2026-08-28T13:31:00.000Z",
        workflowInstanceId: "policy-828-follow-up",
        content: "多部门对828房地产政策作出进一步说明。",
      }],
      [
        policyCandidate("umbrella", "828房地产政策", false),
        policyCandidate("manual-fragment", "人工维护的房地产政策卡片", true),
      ],
      fetcher,
    )).rejects.toThrow("AI Gateway providers failed");
    expect(calls).toBe(2);
  });
});

describe("policy article association", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches one article against all candidate policies in one structured call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const requests: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responsesOutput({
        "policy-1": { related: true },
        "policy-2": { related: false },
      });
    };
    const policies = [
      policyCandidate("policy-1", "房地产信贷政策", false),
      policyCandidate("policy-2", "资本市场政策", false),
    ];
    const article: PolicyArticleEvidence = {
      id: "article-1",
      title: "房地产信贷政策解读",
      summary: "研报分析房地产信贷政策对融资和资产定价的直接影响。",
      author: "测试机构",
      publishedAt: "2026-08-29T09:00:00+08:00",
      keywords: [],
    };

    const matches = await generateArticlePolicyMatches(
      { accountId: "account", gatewayId: "default", token: "token" },
      article,
      policies,
      fetcher,
    );

    expect(matches).toEqual([{ policyId: "policy-1", articleId: "article-1" }]);
    expect(requests).toHaveLength(1);
    expect(POLICY_ASSOCIATION_CONCURRENCY).toBe(5);
    const request = requests[0]!;
    expect(request.prompt_cache_key).toBe(
      `policy-tracking:${POLICY_ASSOCIATION_PROMPT_VERSION}`,
    );
    expect(request.instructions).not.toContain("只输出一个 related 布尔值");
    expect(request.instructions).not.toContain("不得输出置信度");
    const input = request.input as Array<{ content: string }>;
    expect(JSON.parse(input[0]?.content ?? "null")).toMatchObject({
      article: { id: "article-1" },
      policies: [{ id: "policy-1" }, { id: "policy-2" }],
    });
    const format = (request.text as { format: { schema: Record<string, unknown> } }).format;
    expect(format.schema).toMatchObject({
      type: "object",
      properties: {
        "policy-1": {
          type: "object",
          properties: { related: { type: "boolean" } },
          required: ["related"],
          additionalProperties: false,
        },
        "policy-2": {
          type: "object",
          properties: { related: { type: "boolean" } },
          required: ["related"],
          additionalProperties: false,
        },
      },
      required: ["policy-1", "policy-2"],
      additionalProperties: false,
    });
  });

  it("matches one policy against all candidate articles in one structured call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const requests: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responsesOutput({
        "article-1": { related: true },
        "article-2": { related: false },
      });
    };
    const articles: PolicyArticleEvidence[] = [
      {
        id: "article-1",
        title: "房地产信贷政策解读",
        summary: "研报分析房地产信贷政策对融资和资产定价的直接影响。",
        author: "测试机构一",
        publishedAt: "2026-08-29T09:00:00+08:00",
        keywords: [],
      },
      {
        id: "article-2",
        title: "资本市场周报",
        summary: "研报讨论资本市场交易表现，未直接研究房地产政策。",
        author: "测试机构二",
        publishedAt: "2026-08-30T09:00:00+08:00",
        keywords: [],
      },
    ];

    const matches = await generatePolicyArticleMatches(
      { accountId: "account", gatewayId: "default", token: "token" },
      policyCandidate("policy-1", "房地产信贷政策", false),
      articles,
      fetcher,
    );

    expect(matches).toEqual([{ policyId: "policy-1", articleId: "article-1" }]);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const input = request.input as Array<{ content: string }>;
    expect(JSON.parse(input[0]?.content ?? "null")).toMatchObject({
      policy: { id: "policy-1" },
      articles: [{ id: "article-1" }, { id: "article-2" }],
    });
    const format = (request.text as { format: { schema: Record<string, unknown> } }).format;
    expect(format.schema).toMatchObject({
      type: "object",
      properties: {
        "article-1": {
          type: "object",
          properties: { related: { type: "boolean" } },
          required: ["related"],
          additionalProperties: false,
        },
        "article-2": {
          type: "object",
          properties: { related: { type: "boolean" } },
          required: ["related"],
          additionalProperties: false,
        },
      },
      required: ["article-1", "article-2"],
      additionalProperties: false,
    });
  });
});

function policyCandidate(
  id: string,
  title: string,
  mergeProtected: boolean,
): PolicyAggregationCandidate {
  return {
    id,
    title,
    summary: `${title}的政策事实摘要，用于验证已有政策碎片的合并逻辑。`,
    category: "real_estate",
    departments: ["中国人民银行"],
    policyDate: "2026-08-28",
    firstNewsAt: "2026-08-28T17:00:00+08:00",
    lastNewsAt: "2026-08-28T21:00:00+08:00",
    newsTitles: [title],
    mergeProtected,
  };
}

function responsesOutput(value: unknown): Response {
  return Response.json({
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    }],
  });
}

async function createPolicyMergeTestTables(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS policy_event (id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, category TEXT NOT NULL, departments_json TEXT NOT NULL, policy_date TEXT NOT NULL, first_news_at TEXT NOT NULL, last_news_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS policy_news (sentiment_id TEXT PRIMARY KEY, policy_id TEXT, title TEXT NOT NULL, published_at TEXT NOT NULL, content TEXT, link TEXT, aggregation_status TEXT NOT NULL, workflow_instance_id TEXT, discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS article (id TEXT PRIMARY KEY, title TEXT NOT NULL, published_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS policy_article (policy_id TEXT NOT NULL, article_id TEXT NOT NULL, relation_status TEXT NOT NULL, association_method TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (policy_id, article_id))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS research_commentary (id TEXT PRIMARY KEY, policy_id TEXT UNIQUE)"),
  ]);
}
