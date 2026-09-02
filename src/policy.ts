import { z } from "zod";

import {
  fetchCentralPolicyNews,
  fetchResearchReportDetail,
  type ArticleMetadata,
  type Fetcher,
} from "./article";
import {
  generateAiGatewayObject,
  type AiGatewayCredentials,
} from "./ai-gateway";

export const POLICY_PROMPT_VERSION = "policy-aggregation-v2";
export const POLICY_BATCH_SIZE = 40;
export const POLICY_DETAIL_CONCURRENCY = 5;
const POLICY_CLAIM_STALE_MS = 2 * 60 * 60 * 1000;
const POLICY_LOOKBACK_DAYS = 7;

const policyCategorySchema = z.enum([
  "monetary",
  "fiscal",
  "real_estate",
  "capital_market",
  "industry",
  "trade",
  "social",
  "other",
]);

const policyGroupSchema = z.object({
  existingPolicyId: z.string().min(1).nullable(),
  mergePolicyIds: z.array(z.string().min(1)).max(100),
  title: z.string().min(4).max(240),
  summary: z.string().min(20).max(1_600),
  category: policyCategorySchema,
  departments: z.array(z.string().min(2).max(80)).min(1).max(12),
  policyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isIsoDate, "invalid policy date"),
  newsIds: z.array(z.string().min(1)).max(POLICY_BATCH_SIZE),
}).strict();

export type PolicyCategory = z.infer<typeof policyCategorySchema>;

export interface PolicyNewsRow extends ArticleMetadata {
  discoveredAt: string;
  workflowInstanceId: string;
}

export interface PolicyNewsEvidence extends PolicyNewsRow {
  content: string;
  link?: string;
}

export interface ExistingPolicy {
  id: string;
  title: string;
  summary: string;
  category: PolicyCategory;
  departments: string[];
  policyDate: string;
  firstNewsAt: string;
  lastNewsAt: string;
  newsTitles: string[];
}

export interface PolicyAggregationCandidate extends ExistingPolicy {
  mergeProtected: boolean;
}

export interface PolicyAggregationGroup {
  existingPolicyId: string | null;
  mergePolicyIds: string[];
  title: string;
  summary: string;
  category: PolicyCategory;
  departments: string[];
  policyDate: string;
  newsIds: string[];
}

export interface PolicyAggregationResult {
  groups: PolicyAggregationGroup[];
}

export interface PolicyCollectionSummary {
  fetched: number;
  claimed: number;
  workflows: number;
}

export interface PolicyWorkflowParams {
  workflowInstanceId: string;
}

export interface PolicyWorkflowSummary {
  news: number;
  policies: number;
  newPolicies: number;
  updatedPolicies: number;
  mergedPolicies: number;
  policyIds: string[];
}

export interface PolicyArticleAssociationSummary {
  evaluatedPolicies: number;
  evaluatedArticles: number;
  matches: number;
}

export interface PolicyNewsRepository {
  queueAndClaim(
    articles: ArticleMetadata[],
    workflowInstanceId: string,
    discoveredAt: string,
  ): Promise<PolicyNewsRow[]>;
  releaseClaim(workflowInstanceId: string): Promise<void>;
  loadClaimed(workflowInstanceId: string): Promise<PolicyNewsRow[]>;
  loadRecentPolicies(firstPublishedAt: string): Promise<PolicyAggregationCandidate[]>;
  saveAggregation(
    workflowInstanceId: string,
    evidence: PolicyNewsEvidence[],
    aggregation: PolicyAggregationResult,
    savedAt: string,
  ): Promise<PolicyWorkflowSummary>;
}

export interface PolicyWorkflowLauncher {
  start(workflowInstanceId: string): Promise<string>;
}

interface PolicyCollectorDependencies {
  apiBaseUrl: string;
  repository: PolicyNewsRepository;
  workflow: PolicyWorkflowLauncher;
  fetcher?: Fetcher;
}

interface PolicyRow {
  id: string;
  title: string;
  summary: string;
  category: PolicyCategory;
  departments_json: string;
  policy_date: string;
  first_news_at: string;
  last_news_at: string;
}

interface PolicyAggregationCandidateRow extends PolicyRow {
  merge_protected: number;
}

interface PolicyTitleRow {
  policy_id: string;
  title: string;
}

interface ArticleRow {
  id: string;
  title: string;
  summary: string;
  author: string | null;
  published_at: string;
}

interface KeywordRow {
  article_id: string;
  topic: string;
  fact: string;
  interpretation: string;
  impact: string;
}

interface ArticleEvidence {
  id: string;
  title: string;
  summary: string;
  author: string | null;
  publishedAt: string;
  keywords: Array<{
    topic: string;
    fact: string;
    interpretation: string;
    impact: string;
  }>;
}

interface PolicyArticleMatch {
  policyId: string;
  articleId: string;
  confidence: "high" | "medium";
  rationale: string;
}

interface PendingPolicyNewsRow {
  sentiment_id: string;
  news_id: string | null;
  title: string;
  published_at: string;
  discovered_at: string;
  workflow_instance_id: string;
}

const AGGREGATION_INSTRUCTIONS = `你是面向专业投资者的中国政策研究员。输入由“中央政策”标签筛出的新闻正文，以及最近已经建立的政策卡片。

任务是按“政策事件/政策包”而不是按“文件篇数”聚合。每条待处理新闻必须归入一个且仅一个政策事件，并按以下优先级判断：
1. 同日或同一发布窗口内，多部门围绕同一个明确改革目标集中发布、相互配套且分工覆盖不同政策工具或业务环节的多份正式文件，属于同一个政策包。文件名称、发布部门、政策工具或 category 不同，不构成拆分理由。
2. 同一份正式文件、同一次发布会、同一文件的细则、答记者问和拆分快讯，属于同一个政策事件。
3. 只有行业主题相近，但缺少共同改革目标、集中发布安排或明确配套关系的独立政策，才分别建卡。不得仅因都属于房地产、财政、货币等宽泛主题而合并。

“828房地产政策”是必须遵守的业务口径示例：同日集中发布的《商品住房开发贷款管理办法（试行）》及同批房地产融资管理办法、《关于改革完善房地产信贷管理推动加快构建房地产发展新模式的意见》、《关于资本市场支持构建房地产发展新模式的意见》、《关于完善商品住房销售制度的通知》，以及相关答问、拆分要点和总览，统一归为一个“828房地产政策”事件，不按文件或主管部门拆卡。

已有卡片也必须按上述口径复核。若多个 existingPolicies 实际是同一政策包的碎片：用 existingPolicyId 指向标题和摘要最能覆盖整组政策包的卡片，并把其余卡片 ID 全部放入 mergePolicyIds；若没有明显总览卡片，选 firstNewsAt 最早者作为 existingPolicyId。即使本批没有属于该政策包的新资讯，也可以输出 newsIds=[] 的合并组。mergeProtected=true 的卡片包含人工关系或研究点评，只能作为 existingPolicyId 保留，绝不能放入 mergePolicyIds。新建政策时 existingPolicyId=null 且 mergePolicyIds=[]。

标题应采用覆盖整组措施的市场通行简称或政策包名称；只有单一文件事件才使用正式文件名。summary 必须累计概括该政策包的全部输入事实，包括 existingPolicies 和 pendingNews，不补充外部知识。policyDate 使用集中发布日或正式发布日；材料未提供时使用该组最早资讯的上海日期。departments 应累计保留整组输入明确出现的发布部门。

必须覆盖全部待处理 newsIds，且每个 newsId 只能出现一次。严格按 JSON Schema 输出，不输出 Markdown、解释过程或额外字段。`;

const ASSOCIATION_INSTRUCTIONS = `你是专业金融研究资料管理员。输入包含已经结构化的政策卡片和研报证据卡片。请只返回与政策存在直接研究关系的政策—研报配对。

可以关联的情形：研报明确解读该政策文件、同一组配套措施、政策传导或对资产定价与融资的直接影响。仅仅同属房地产、财政、货币等宽泛主题，或只是背景中顺带提及，不得关联。拿不准时不关联。

confidence=high 表示标题或摘要已明确指向该政策；confidence=medium 表示结构化事实与政策动作一致但标题未直接点名。rationale 用一句话说明直接证据，不得补充输入外事实。严格按 JSON Schema 输出，不输出 Markdown、过程或额外字段。`;

export async function runPolicyCollection(
  dependencies: PolicyCollectorDependencies,
  discoveredAt: string,
): Promise<PolicyCollectionSummary> {
  const articles = await fetchCentralPolicyNews(
    dependencies.apiBaseUrl,
    dependencies.fetcher,
  );
  const workflowInstanceId = policyWorkflowInstanceId(discoveredAt);
  const claimed = await dependencies.repository.queueAndClaim(
    articles,
    workflowInstanceId,
    discoveredAt,
  );
  if (claimed.length === 0) {
    return { fetched: articles.length, claimed: 0, workflows: 0 };
  }
  try {
    await dependencies.workflow.start(workflowInstanceId);
  } catch (error) {
    await dependencies.repository.releaseClaim(workflowInstanceId);
    throw error;
  }
  return { fetched: articles.length, claimed: claimed.length, workflows: 1 };
}

export async function collectPolicies(
  env: Env,
  discoveredAt: string,
): Promise<PolicyCollectionSummary> {
  return await runPolicyCollection(
    {
      apiBaseUrl: env.ARTICLE_API_BASE_URL,
      repository: new D1PolicyNewsRepository(env.DB),
      workflow: new CloudflarePolicyWorkflowLauncher(env.POLICY_WORKFLOW),
    },
    discoveredAt,
  );
}

export async function loadPolicyEvidence(
  apiBaseUrl: string,
  rows: PolicyNewsRow[],
  fetcher: Fetcher = fetch,
): Promise<PolicyNewsEvidence[]> {
  return await mapWithConcurrency(rows, POLICY_DETAIL_CONCURRENCY, async (row) => {
    const detail = await fetchResearchReportDetail(apiBaseUrl, row, fetcher);
    return {
      ...row,
      content: detail.content,
      ...(detail.link ? { link: detail.link } : {}),
    };
  });
}

export async function generatePolicyAggregation(
  credentials: AiGatewayCredentials,
  evidence: PolicyNewsEvidence[],
  existingPolicies: PolicyAggregationCandidate[],
  fetcher: typeof fetch = fetch,
): Promise<PolicyAggregationResult> {
  if (evidence.length === 0) throw new Error("Policy aggregation requires news evidence");
  const schema = policyAggregationSchema(
    evidence.map((item) => item.id),
    existingPolicies,
  );
  return await generateAiGatewayObject(
    credentials,
    [
      { role: "system", content: AGGREGATION_INSTRUCTIONS },
      {
        role: "user",
        content: JSON.stringify({
          existingPolicies,
          pendingNews: evidence.map((item) => ({
            newsId: item.id,
            title: item.title,
            publishedAt: item.publishedAt,
            publishedDateShanghai: isoDatePart(item.publishedAt),
            content: item.content,
          })),
        }),
      },
    ],
    schema,
    "policy_aggregation",
    {
      promptCacheKey: `policy-tracking:${POLICY_PROMPT_VERSION}`,
      requestTimeoutMs: 300_000,
      taskType: "generation",
      metadata: {
        prompt_version: POLICY_PROMPT_VERSION,
        news_count: evidence.length,
        existing_policy_count: existingPolicies.length,
        tags: "policy-tracking,workflow,central-policy",
      },
    },
    fetcher,
  );
}

export async function associateArticleWithPolicies(
  env: Pick<Env, "DB" | "CLOUDFLARE_ACCOUNT_ID" | "AI_GATEWAY_ID" | "CF_AIG_TOKEN">,
  articleId: string,
): Promise<PolicyArticleAssociationSummary> {
  const repository = new D1PolicyAssociationRepository(env.DB);
  const article = await repository.loadArticle(articleId);
  if (!article) return { evaluatedPolicies: 0, evaluatedArticles: 0, matches: 0 };
  const policies = await repository.loadPoliciesForArticle(article.publishedAt);
  if (policies.length === 0) {
    return { evaluatedPolicies: 0, evaluatedArticles: 1, matches: 0 };
  }
  const matches = await generatePolicyArticleMatches(
    credentialsFromEnv(env),
    policies,
    [article],
  );
  await repository.saveAutomaticMatches(matches, new Date().toISOString());
  return {
    evaluatedPolicies: policies.length,
    evaluatedArticles: 1,
    matches: matches.length,
  };
}

export async function associatePoliciesWithArticles(
  env: Pick<Env, "DB" | "CLOUDFLARE_ACCOUNT_ID" | "AI_GATEWAY_ID" | "CF_AIG_TOKEN">,
  policyIds: string[],
): Promise<PolicyArticleAssociationSummary> {
  const repository = new D1PolicyAssociationRepository(env.DB);
  const policies = await repository.loadPolicies(policyIds);
  if (policies.length === 0) {
    return { evaluatedPolicies: 0, evaluatedArticles: 0, matches: 0 };
  }
  const articles = await repository.loadArticlesForPolicies(policies);
  if (articles.length === 0) {
    return { evaluatedPolicies: policies.length, evaluatedArticles: 0, matches: 0 };
  }
  const matches = await generatePolicyArticleMatches(
    credentialsFromEnv(env),
    policies,
    articles,
  );
  await repository.saveAutomaticMatches(matches, new Date().toISOString());
  return {
    evaluatedPolicies: policies.length,
    evaluatedArticles: articles.length,
    matches: matches.length,
  };
}

export class D1PolicyNewsRepository implements PolicyNewsRepository {
  constructor(private readonly database: D1Database) {}

  async queueAndClaim(
    articles: ArticleMetadata[],
    workflowInstanceId: string,
    discoveredAt: string,
  ): Promise<PolicyNewsRow[]> {
    const normalizedDiscoveredAt = requireIsoDateTime(discoveredAt, "Policy discoveredAt");
    const staleBefore = new Date(
      new Date(normalizedDiscoveredAt).valueOf() - POLICY_CLAIM_STALE_MS,
    ).toISOString();
    if (articles.length > 0) {
      const insert = this.database.prepare(`
        INSERT INTO policy_news (
          sentiment_id, news_id, title, published_at, tags_json,
          aggregation_status, discovered_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(sentiment_id) DO NOTHING
      `);
      await this.database.batch(articles.map((article) => insert.bind(
        article.id,
        article.newsId ?? null,
        article.title,
        article.publishedAt,
        JSON.stringify(["中央政策"]),
        normalizedDiscoveredAt,
        normalizedDiscoveredAt,
      )));
    }

    const candidates = await this.database.prepare(`
      SELECT sentiment_id
      FROM policy_news
      WHERE aggregation_status = 'pending'
        AND (workflow_instance_id IS NULL OR claimed_at IS NULL OR claimed_at < ?)
      ORDER BY published_at ASC, sentiment_id ASC
      LIMIT ?
    `).bind(staleBefore, POLICY_BATCH_SIZE).all<{ sentiment_id: string }>();
    if (candidates.results.length === 0) return [];
    const claim = this.database.prepare(`
      UPDATE policy_news
      SET workflow_instance_id = ?, claimed_at = ?, updated_at = ?
      WHERE sentiment_id = ?
        AND aggregation_status = 'pending'
        AND (workflow_instance_id IS NULL OR claimed_at IS NULL OR claimed_at < ?)
    `);
    await this.database.batch(candidates.results.map((row) => claim.bind(
      workflowInstanceId,
      normalizedDiscoveredAt,
      normalizedDiscoveredAt,
      row.sentiment_id,
      staleBefore,
    )));
    return await this.loadClaimed(workflowInstanceId);
  }

  async releaseClaim(workflowInstanceId: string): Promise<void> {
    await this.database.prepare(`
      UPDATE policy_news
      SET workflow_instance_id = NULL, claimed_at = NULL, updated_at = ?
      WHERE workflow_instance_id = ? AND aggregation_status = 'pending'
    `).bind(new Date().toISOString(), workflowInstanceId).run();
  }

  async loadClaimed(workflowInstanceId: string): Promise<PolicyNewsRow[]> {
    const result = await this.database.prepare(`
      SELECT sentiment_id, news_id, title, published_at, discovered_at, workflow_instance_id
      FROM policy_news
      WHERE workflow_instance_id = ? AND aggregation_status = 'pending'
      ORDER BY published_at ASC, sentiment_id ASC
    `).bind(workflowInstanceId).all<PendingPolicyNewsRow>();
    return result.results.map((row) => ({
      id: row.sentiment_id,
      ...(row.news_id ? { newsId: row.news_id } : {}),
      title: row.title,
      publishedAt: row.published_at,
      discoveredAt: row.discovered_at,
      workflowInstanceId: row.workflow_instance_id,
    }));
  }

  async loadRecentPolicies(firstPublishedAt: string): Promise<PolicyAggregationCandidate[]> {
    const cutoff = new Date(firstPublishedAt);
    if (Number.isNaN(cutoff.valueOf())) throw new Error("Policy publishedAt is invalid");
    cutoff.setUTCDate(cutoff.getUTCDate() - POLICY_LOOKBACK_DAYS);
    const policies = await this.database.prepare(`
      SELECT pe.id, pe.title, pe.summary, pe.category, pe.departments_json, pe.policy_date,
             pe.first_news_at, pe.last_news_at,
             CASE WHEN
               EXISTS (
                 SELECT 1 FROM policy_article pa
                 WHERE pa.policy_id = pe.id AND pa.association_method = 'manual'
               ) OR EXISTS (
                 SELECT 1 FROM research_commentary rc WHERE rc.policy_id = pe.id
               )
             THEN 1 ELSE 0 END AS merge_protected
      FROM policy_event pe
      WHERE pe.last_news_at >= ?
      ORDER BY pe.last_news_at DESC, pe.id DESC
      LIMIT 100
    `).bind(cutoff.toISOString()).all<PolicyAggregationCandidateRow>();
    if (policies.results.length === 0) return [];
    const placeholders = policies.results.map(() => "?").join(", ");
    const titles = await this.database.prepare(`
      SELECT policy_id, title
      FROM policy_news
      WHERE policy_id IN (${placeholders})
      ORDER BY published_at ASC, sentiment_id ASC
    `).bind(...policies.results.map((row) => row.id)).all<PolicyTitleRow>();
    const titlesByPolicy = new Map<string, string[]>();
    for (const row of titles.results) {
      const group = titlesByPolicy.get(row.policy_id) ?? [];
      group.push(row.title);
      titlesByPolicy.set(row.policy_id, group);
    }
    return policies.results.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      category: row.category,
      departments: parseDepartments(row.departments_json),
      policyDate: row.policy_date,
      firstNewsAt: row.first_news_at,
      lastNewsAt: row.last_news_at,
      newsTitles: titlesByPolicy.get(row.id) ?? [],
      mergeProtected: row.merge_protected === 1,
    }));
  }

  async saveAggregation(
    workflowInstanceId: string,
    evidence: PolicyNewsEvidence[],
    aggregation: PolicyAggregationResult,
    savedAt: string,
  ): Promise<PolicyWorkflowSummary> {
    const normalizedSavedAt = requireIsoDateTime(savedAt, "Policy savedAt");
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const referencedPolicyIds = uniqueStrings(aggregation.groups.flatMap((group) => [
      ...(group.existingPolicyId ? [group.existingPolicyId] : []),
      ...group.mergePolicyIds,
    ]));
    const existingPolicies = await this.loadAggregationPolicies(referencedPolicyIds);
    const statements: D1PreparedStatement[] = [];
    const policyIds: string[] = [];
    let newPolicies = 0;
    let updatedPolicies = 0;
    let mergedPolicies = 0;
    for (const group of aggregation.groups) {
      const policyId = group.existingPolicyId ?? crypto.randomUUID();
      policyIds.push(policyId);
      const groupedNews = group.newsIds.map((id) => {
        const item = evidenceById.get(id);
        if (!item) throw new Error(`Policy aggregation referenced unavailable news ${id}`);
        return item;
      }).sort((left, right) => left.publishedAt.localeCompare(right.publishedAt));
      const canonicalPolicy = group.existingPolicyId
        ? existingPolicies.get(group.existingPolicyId)
        : undefined;
      if (group.existingPolicyId && !canonicalPolicy) {
        throw new Error(`Policy aggregation referenced missing policy ${group.existingPolicyId}`);
      }
      const mergedPolicyRows = group.mergePolicyIds.flatMap((id) => {
        const policy = existingPolicies.get(id);
        return policy ? [policy] : [];
      });
      const protectedMerge = mergedPolicyRows.find((policy) => policy.merge_protected === 1);
      if (protectedMerge) {
        throw new Error(`Policy ${protectedMerge.id} has manual curation and cannot be merged`);
      }
      const sourcePolicies = [
        ...(canonicalPolicy ? [canonicalPolicy] : []),
        ...mergedPolicyRows,
      ];
      const firstNewsAt = minString([
        ...sourcePolicies.map((policy) => policy.first_news_at),
        ...groupedNews.map((item) => item.publishedAt),
      ], "Policy aggregation has no news evidence");
      const lastNewsAt = maxString([
        ...sourcePolicies.map((policy) => policy.last_news_at),
        ...groupedNews.map((item) => item.publishedAt),
      ], "Policy aggregation has no news evidence");
      const policyDate = minString([
        group.policyDate,
        ...sourcePolicies.map((policy) => policy.policy_date),
      ], "Policy aggregation has no policy date");
      const departments = uniqueStrings([
        ...group.departments,
        ...sourcePolicies.flatMap((policy) => parseDepartments(policy.departments_json)),
      ]);
      if (group.existingPolicyId) {
        updatedPolicies += 1;
        statements.push(this.database.prepare(`
          UPDATE policy_event
          SET title = ?, summary = ?, category = ?, departments_json = ?,
              policy_date = ?, first_news_at = ?, last_news_at = ?,
              updated_at = ?
          WHERE id = ?
        `).bind(
          group.title,
          group.summary,
          group.category,
          JSON.stringify(departments),
          policyDate,
          firstNewsAt,
          lastNewsAt,
          normalizedSavedAt,
          policyId,
        ));
      } else {
        newPolicies += 1;
        statements.push(this.database.prepare(`
          INSERT INTO policy_event (
            id, title, summary, category, departments_json, policy_date,
            first_news_at, last_news_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          policyId,
          group.title,
          group.summary,
          group.category,
          JSON.stringify(departments),
          policyDate,
          firstNewsAt,
          lastNewsAt,
          normalizedSavedAt,
          normalizedSavedAt,
        ));
      }
      for (const mergedPolicy of mergedPolicyRows) {
        mergedPolicies += 1;
        statements.push(this.database.prepare(`
          INSERT OR IGNORE INTO policy_article (
            policy_id, article_id, relation_status, association_method,
            confidence, rationale, created_at, updated_at
          )
          SELECT ?, article_id, relation_status, association_method,
                 confidence, rationale, created_at, updated_at
          FROM policy_article
          WHERE policy_id = ? AND association_method = 'ai'
        `).bind(policyId, mergedPolicy.id));
        statements.push(this.database.prepare(`
          DELETE FROM policy_article
          WHERE policy_id = ? AND association_method = 'ai'
        `).bind(mergedPolicy.id));
        statements.push(this.database.prepare(`
          UPDATE policy_news
          SET policy_id = ?, updated_at = ?
          WHERE policy_id = ? AND aggregation_status = 'grouped'
        `).bind(policyId, normalizedSavedAt, mergedPolicy.id));
        statements.push(this.database.prepare(`
          DELETE FROM policy_event WHERE id = ?
        `).bind(mergedPolicy.id));
      }
      for (const item of groupedNews) {
        statements.push(this.database.prepare(`
          UPDATE policy_news
          SET policy_id = ?, content = ?, link = ?, aggregation_status = 'grouped',
              updated_at = ?
          WHERE sentiment_id = ? AND workflow_instance_id = ?
            AND aggregation_status = 'pending'
        `).bind(
          policyId,
          item.content,
          item.link ?? null,
          normalizedSavedAt,
          item.id,
          workflowInstanceId,
        ));
      }
    }
    if (statements.length === 0) throw new Error("Policy aggregation produced no writes");
    await this.database.batch(statements);
    const remaining = await this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM policy_news
      WHERE workflow_instance_id = ? AND aggregation_status = 'pending'
    `).bind(workflowInstanceId).first<{ count: number }>();
    if ((remaining?.count ?? 0) !== 0) {
      throw new Error("Policy aggregation did not persist every claimed news item");
    }
    return {
      news: evidence.length,
      policies: aggregation.groups.length,
      newPolicies,
      updatedPolicies,
      mergedPolicies,
      policyIds,
    };
  }

  private async loadAggregationPolicies(
    policyIds: string[],
  ): Promise<Map<string, PolicyAggregationCandidateRow>> {
    if (policyIds.length === 0) return new Map();
    const placeholders = policyIds.map(() => "?").join(", ");
    const result = await this.database.prepare(`
      SELECT pe.id, pe.title, pe.summary, pe.category, pe.departments_json, pe.policy_date,
             pe.first_news_at, pe.last_news_at,
             CASE WHEN
               EXISTS (
                 SELECT 1 FROM policy_article pa
                 WHERE pa.policy_id = pe.id AND pa.association_method = 'manual'
               ) OR EXISTS (
                 SELECT 1 FROM research_commentary rc WHERE rc.policy_id = pe.id
               )
             THEN 1 ELSE 0 END AS merge_protected
      FROM policy_event pe
      WHERE pe.id IN (${placeholders})
    `).bind(...policyIds).all<PolicyAggregationCandidateRow>();
    return new Map(result.results.map((policy) => [policy.id, policy]));
  }
}

export class D1PolicyAssociationRepository {
  constructor(private readonly database: D1Database) {}

  async loadArticle(articleId: string): Promise<ArticleEvidence | null> {
    const article = await this.database.prepare(`
      SELECT id, title, summary, author, published_at
      FROM article
      WHERE id = ? AND summary IS NOT NULL
    `).bind(articleId).first<ArticleRow>();
    if (!article) return null;
    return (await this.attachKeywords([article]))[0] ?? null;
  }

  async loadPoliciesForArticle(publishedAt: string): Promise<ExistingPolicy[]> {
    const articleDate = isoDatePart(publishedAt);
    const startDate = offsetIsoDate(articleDate, -14);
    const endDate = offsetIsoDate(articleDate, 1);
    return await this.queryPolicies(`policy_date BETWEEN ? AND ?`, [startDate, endDate]);
  }

  async loadPolicies(policyIds: string[]): Promise<ExistingPolicy[]> {
    const uniqueIds = [...new Set(policyIds)];
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    return await this.queryPolicies(`id IN (${placeholders})`, uniqueIds);
  }

  async loadArticlesForPolicies(policies: ExistingPolicy[]): Promise<ArticleEvidence[]> {
    if (policies.length === 0) return [];
    const startDate = policies
      .map((policy) => offsetIsoDate(policy.policyDate, -1))
      .sort()[0]!;
    const endDate = policies
      .map((policy) => offsetIsoDate(policy.policyDate, 14))
      .sort()
      .at(-1)!;
    const result = await this.database.prepare(`
      SELECT id, title, summary, author, published_at
      FROM article
      WHERE summary IS NOT NULL
        AND substr(published_at, 1, 10) BETWEEN ? AND ?
      ORDER BY published_at DESC, id DESC
      LIMIT 100
    `).bind(startDate, endDate).all<ArticleRow>();
    return await this.attachKeywords(result.results);
  }

  async saveAutomaticMatches(matches: PolicyArticleMatch[], savedAt: string): Promise<void> {
    if (matches.length === 0) return;
    const normalizedSavedAt = requireIsoDateTime(savedAt, "Policy association savedAt");
    const statement = this.database.prepare(`
      INSERT INTO policy_article (
        policy_id, article_id, relation_status, association_method,
        confidence, rationale, created_at, updated_at
      ) VALUES (?, ?, 'linked', 'ai', ?, ?, ?, ?)
      ON CONFLICT(policy_id, article_id) DO UPDATE SET
        relation_status = 'linked',
        confidence = excluded.confidence,
        rationale = excluded.rationale,
        updated_at = excluded.updated_at
      WHERE policy_article.association_method = 'ai'
    `);
    await this.database.batch(matches.map((match) => statement.bind(
      match.policyId,
      match.articleId,
      match.confidence,
      match.rationale,
      normalizedSavedAt,
      normalizedSavedAt,
    )));
  }

  private async queryPolicies(where: string, bindings: string[]): Promise<ExistingPolicy[]> {
    const result = await this.database.prepare(`
      SELECT id, title, summary, category, departments_json, policy_date,
             first_news_at, last_news_at
      FROM policy_event
      WHERE ${where}
      ORDER BY policy_date DESC, last_news_at DESC, id DESC
      LIMIT 100
    `).bind(...bindings).all<PolicyRow>();
    if (result.results.length === 0) return [];
    const placeholders = result.results.map(() => "?").join(", ");
    const titles = await this.database.prepare(`
      SELECT policy_id, title
      FROM policy_news
      WHERE policy_id IN (${placeholders})
      ORDER BY published_at ASC, sentiment_id ASC
    `).bind(...result.results.map((row) => row.id)).all<PolicyTitleRow>();
    const titlesByPolicy = new Map<string, string[]>();
    for (const row of titles.results) {
      const values = titlesByPolicy.get(row.policy_id) ?? [];
      values.push(row.title);
      titlesByPolicy.set(row.policy_id, values);
    }
    return result.results.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      category: row.category,
      departments: parseDepartments(row.departments_json),
      policyDate: row.policy_date,
      firstNewsAt: row.first_news_at,
      lastNewsAt: row.last_news_at,
      newsTitles: titlesByPolicy.get(row.id) ?? [],
    }));
  }

  private async attachKeywords(articles: ArticleRow[]): Promise<ArticleEvidence[]> {
    if (articles.length === 0) return [];
    const placeholders = articles.map(() => "?").join(", ");
    const keywords = await this.database.prepare(`
      SELECT article_id, topic, fact, interpretation, impact
      FROM keyword
      WHERE article_id IN (${placeholders})
      ORDER BY article_id ASC, ordinal ASC
    `).bind(...articles.map((article) => article.id)).all<KeywordRow>();
    const byArticle = new Map<string, ArticleEvidence["keywords"]>();
    for (const row of keywords.results) {
      const values = byArticle.get(row.article_id) ?? [];
      values.push({
        topic: row.topic,
        fact: row.fact,
        interpretation: row.interpretation,
        impact: row.impact,
      });
      byArticle.set(row.article_id, values);
    }
    return articles.map((article) => ({
      id: article.id,
      title: article.title,
      summary: article.summary,
      author: article.author,
      publishedAt: article.published_at,
      keywords: byArticle.get(article.id) ?? [],
    }));
  }
}

export class CloudflarePolicyWorkflowLauncher implements PolicyWorkflowLauncher {
  constructor(private readonly workflow: Env["POLICY_WORKFLOW"]) {}

  async start(workflowInstanceId: string): Promise<string> {
    const instance = await this.workflow.create({
      id: workflowInstanceId,
      params: { workflowInstanceId },
    });
    return instance.id;
  }
}

export function policyWorkflowInstanceId(discoveredAt: string): string {
  const timestamp = new Date(discoveredAt).valueOf();
  if (!Number.isFinite(timestamp)) throw new Error("Policy discoveredAt must be an ISO date-time");
  return `policy-${timestamp}`;
}

function policyAggregationSchema(
  newsIds: string[],
  existingPolicies: PolicyAggregationCandidate[],
) {
  const newsIdSet = new Set(newsIds);
  const existingIdSet = new Set(existingPolicies.map((policy) => policy.id));
  const mergeableIdSet = new Set(
    existingPolicies.filter((policy) => !policy.mergeProtected).map((policy) => policy.id),
  );
  return z.object({
    groups: z.array(policyGroupSchema).min(1).max(POLICY_BATCH_SIZE + existingPolicies.length),
  }).strict().superRefine((value, context) => {
    const assigned = new Set<string>();
    const reusedPolicies = new Set<string>();
    for (const [groupIndex, group] of value.groups.entries()) {
      if (!group.existingPolicyId && group.mergePolicyIds.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["groups", groupIndex, "mergePolicyIds"],
          message: "a new policy cannot merge existing policy cards",
        });
      }
      if (group.newsIds.length === 0 && (
        !group.existingPolicyId || group.mergePolicyIds.length === 0
      )) {
        context.addIssue({
          code: "custom",
          path: ["groups", groupIndex, "newsIds"],
          message: "an existing-only group must merge at least two policy cards",
        });
      }
      if (group.existingPolicyId) {
        if (!existingIdSet.has(group.existingPolicyId)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "existingPolicyId"],
            message: "must reference an available existing policy",
          });
        }
        if (reusedPolicies.has(group.existingPolicyId)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "existingPolicyId"],
            message: "the same existing policy cannot appear in multiple groups",
          });
        }
        reusedPolicies.add(group.existingPolicyId);
      }
      for (const id of group.mergePolicyIds) {
        if (!existingIdSet.has(id)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "mergePolicyIds"],
            message: `unknown policy ID ${id}`,
          });
        }
        if (!mergeableIdSet.has(id)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "mergePolicyIds"],
            message: `policy ${id} is protected from automatic merging`,
          });
        }
        if (reusedPolicies.has(id)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "mergePolicyIds"],
            message: `policy ${id} is assigned more than once`,
          });
        }
        reusedPolicies.add(id);
      }
      for (const id of group.newsIds) {
        if (!newsIdSet.has(id)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "newsIds"],
            message: `unknown newsId ${id}`,
          });
        }
        if (assigned.has(id)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "newsIds"],
            message: `newsId ${id} is assigned more than once`,
          });
        }
        assigned.add(id);
      }
    }
    for (const id of newsIds) {
      if (!assigned.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["groups"],
          message: `newsId ${id} is not assigned`,
        });
      }
    }
  });
}

async function generatePolicyArticleMatches(
  credentials: AiGatewayCredentials,
  policies: ExistingPolicy[],
  articles: ArticleEvidence[],
): Promise<PolicyArticleMatch[]> {
  const policyIds = new Set(policies.map((item) => item.id));
  const articleIds = new Set(articles.map((item) => item.id));
  const validPairs = new Set(
    policies.flatMap((policy) => articles
      .filter((article) => {
        const articleDate = isoDatePart(article.publishedAt);
        return articleDate >= offsetIsoDate(policy.policyDate, -1)
          && articleDate <= offsetIsoDate(policy.policyDate, 14);
      })
      .map((article) => `${policy.id}\u0000${article.id}`)),
  );
  const schema = z.object({
    matches: z.array(z.object({
      policyId: z.string().min(1),
      articleId: z.string().min(1),
      confidence: z.enum(["high", "medium"]),
      rationale: z.string().min(10).max(320),
    }).strict()).max(Math.min(100, policies.length * articles.length)),
  }).strict().superRefine((value, context) => {
    const pairs = new Set<string>();
    for (const [index, match] of value.matches.entries()) {
      if (!policyIds.has(match.policyId) || !articleIds.has(match.articleId)) {
        context.addIssue({
          code: "custom",
          path: ["matches", index],
          message: "match must reference supplied policy and article IDs",
        });
      }
      const pair = `${match.policyId}\u0000${match.articleId}`;
      if (!validPairs.has(pair)) {
        context.addIssue({
          code: "custom",
          path: ["matches", index],
          message: "match falls outside the policy association date window",
        });
      }
      if (pairs.has(pair)) {
        context.addIssue({
          code: "custom",
          path: ["matches", index],
          message: "duplicate policy and article match",
        });
      }
      pairs.add(pair);
    }
  });
  const result = await generateAiGatewayObject(
    credentials,
    [
      { role: "system", content: ASSOCIATION_INSTRUCTIONS },
      {
        role: "user",
        content: JSON.stringify({ policies, articles }),
      },
    ],
    schema,
    "policy_article_association",
    {
      promptCacheKey: "policy-tracking:article-association-v1",
      requestTimeoutMs: 300_000,
      taskType: "analysis",
      metadata: {
        policy_count: policies.length,
        article_count: articles.length,
        tags: "policy-tracking,article-association",
      },
    },
  );
  return result.matches;
}

function credentialsFromEnv(
  env: Pick<Env, "CLOUDFLARE_ACCOUNT_ID" | "AI_GATEWAY_ID" | "CF_AIG_TOKEN">,
): AiGatewayCredentials {
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    gatewayId: env.AI_GATEWAY_ID,
    token: env.CF_AIG_TOKEN,
  };
}

function isoDatePart(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error("Date-time is invalid");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

function offsetIsoDate(value: string, days: number): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf())) throw new Error("ISO date is invalid");
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function isIsoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseDepartments(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value;
    }
  } catch {
    // Fall through to the explicit storage error below.
  }
  throw new Error("Stored policy departments are invalid");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function minString(values: string[], errorMessage: string): string {
  const sorted = [...values].sort();
  const value = sorted[0];
  if (!value) throw new Error(errorMessage);
  return value;
}

function maxString(values: string[], errorMessage: string): string {
  const sorted = [...values].sort();
  const value = sorted.at(-1);
  if (!value) throw new Error(errorMessage);
  return value;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function requireIsoDateTime(value: string, label: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) throw new Error(`${label} must be an ISO date-time`);
  return timestamp.toISOString();
}
