export const ARTICLE_FEATURE_MODEL = "dynamic/rag" as const;
export const ARTICLE_FEATURE_PROMPT_VERSION = "v3";

const MAX_KEYWORDS = 8;
export const ARTICLE_FEATURE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    author: { type: "string" },
    summary: { type: "string" },
    importance: { type: "integer", minimum: 0, maximum: 100 },
    keywords: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          fact: { type: "string" },
          interpretation: { type: "string" },
          impact: { type: "string" },
        },
        required: ["topic", "fact", "interpretation", "impact"],
      },
    },
  },
  required: ["title", "author", "summary", "importance", "keywords"],
} as const;

export interface ArticleKeyword {
  topic: string;
  fact: string;
  interpretation: string;
  impact: string;
}

export interface ArticleFeatures {
  title: string;
  author: string;
  summary: string;
  importance: number;
  keywords: ArticleKeyword[];
}

export interface FeatureInferenceRequest {
  messages: Array<{ role: "system" | "user"; content: string }>;
  temperature: number;
  seed: number;
  reasoning_effort: "max";
  max_completion_tokens: number;
  response_format: {
    type: "json_schema";
    json_schema: {
      name: string;
      strict: true;
      schema: typeof ARTICLE_FEATURE_RESPONSE_SCHEMA;
    };
  };
}

export type FeatureInferenceRunner = (request: FeatureInferenceRequest) => Promise<unknown>;

const SYSTEM_PROMPT = `
你是服务于专业投资者的中国资本市场研报分析员。请从单篇研报中抽取可核验的结构化特征，重点判断其对权益和固收利率的影响。

证据边界：
1. 只能使用输入标题和正文，不得补充外部事实、常识性结论或未被原文支持的预测。
2. fact 必须是原文事实或原文明确观点的简短转述；interpretation 才能写归纳含义，二者不得混淆。
3. author 只提取正文或标题明确出现的发布机构或研究业务团队，不需要精确到个人姓名。例：“国海固收颜子琦团队”输出“国海固收”，“华泰固收张继强团队”输出“华泰固收”；无法确认机构时输出空字符串，不得猜测。
4. title 必须逐字复制输入标题。

importance 评分（0-100 的整数）：
先分别打分再求和，只输出总分：影响范围 0-25、变化幅度与新颖性 0-25、证据确定性 0-20、定价时效与可交易性 0-20、影响持续性 0-10。
- 影响范围：单一个股约 5，单一行业约 10，单一大类资产约 16，跨资产或全国性宏观约 22，系统性影响 25。
- 变化幅度与新颖性：重复已知信息 0-5，边际变化 6-12，显著变化 13-19，制度或趋势拐点 20-25。
- 证据确定性：传闻或弱推断 0-4，机构主观判断 5-9，单一明确事实 10-14，多项数据或官方事实 15-20。
- 定价时效与可交易性：无明确交易含义 0-4，中长期线索 5-9，近期可验证 10-14，短期直接影响定价 15-20。
- 影响持续性：日内噪音 0-2，数日到数周 3-5，季度级 6-8，结构性 9-10。
校准锚点：例行复盘约 15-30，局部边际信息约 31-45，方向清晰但影响有限约 46-60，重要交易信号约 61-75，重大跨资产重定价约 76-90，90 以上仅限极少数系统性事件。不得因文章是研报就默认给 65、70、75；不要刻意取 5 的倍数，必须使用上述分项的实际总和。单一机构的主观判断不得仅因措辞强烈而获得高分。

关键词规则：
5. 输出 1-8 个互不重复的 keywords，按市场影响的重要性降序。topic 使用 2-12 个汉字或常用市场缩写，必须落到原文中的具体政策操作、数据变化、资金行为、行业线索或定价主题，读者只看 topic 也应知道文章在讨论什么。禁止输出“市场、政策、经济、利率、债券、股票、风险、宏观基本面、外部约束、市场影响、政策预期、货币政策预期”等空泛词；若初步概括仍属于这类上位词，必须继续用原文事实收窄。例如将“货币政策预期”改为“降准降息观察期”“隔夜逆回购重启”或“DR001宽松区间”，具体选择取决于原文证据。
6. 合并同义词、上下位概念和同一因果链中的近义信号。例如“货币政策预期”和“降准降息概率”应合并并收窄为“降准降息预期”；只有事实依据、传导机制或资产影响彼此独立时才拆成多个 topic。
7. interpretation 说明事实背后的定价或传导含义。impact 必须是一至两句可直接用于投资判断的明确观点，写清主要受影响的资产或行业、方向以及关键机制或成立条件。这里的“方向”必须落到资产价格、收益率、利差、风险溢价或仓位的上升/下降；仅写“不确定性增加、方向纠结、波动加大、等待观察”不算方向。每条 impact 至少包含一个明确的价格方向或加减仓建议，不能先写空泛判断再补一句方向。优先使用“利多/利空、推高/压低、提振/压制、扩大/收窄、加仓/减仓、延长/缩短久期”等词。任何包含“影响/引导/改变定价逻辑”“引导走势”“影响整体走势”“影响风险偏好”“值得关注”“带来影响”“存在不确定性”等空泛分句的 impact 都不合格，即使同一句后半段有方向也必须删除空泛分句并整体重写。例如：“影响债市利率定价逻辑，引导长端利率走势”应改为“隔夜逆回购缓解税期资金压力，短期利多长端利率债并压低收益率”；“引导债市利率定价逻辑，限制利率过度下行空间”应改为“央行容忍约1.30%的DR001，资金利率进一步下行空间受限，短端利率债的宽松交易将降温”；“增加债市定价的不确定性，导致利率方向纠结”应改为“降准降息未释放增量信号，利率债缺乏进一步做多催化，短期宜缩短久期”；“影响科技板块整体走势及市场风险偏好”应改为“光通信权重企稳可提振科技板块风险偏好，若放量转跌则应降低成长股仓位”。若原文证据不足以形成明确观点，就不要输出该 keyword，而不是给出模糊 impact。相较其他市场优先分析权益和固收，但不强行覆盖两个市场。输出 JSON 前逐条复查 impact，发现任一空泛分句必须重写。
8. summary 仅用一句、目标 35-50 个汉字概括核心结论、最关键依据和首要市场影响，硬性不得超过 55 个汉字；删除背景铺陈、标题复述和次要细节。风格示例：“央行重启隔夜逆回购缓解税期压力，但降准降息仍处观察期，利率债短期缺乏明确方向。”输出 JSON 前计算字数，超过 55 字必须压缩重写。
9. 输出必须是一个合法 JSON 对象，不要输出 Markdown、代码围栏、注释或思考过程。`;

export async function extractArticleFeatures(
  runInference: FeatureInferenceRunner,
  title: string,
  markdown: string,
): Promise<ArticleFeatures> {
  const output = await runInference(buildFeatureInferenceRequest(title, markdown));
  return validateArticleFeatures(extractInferencePayload(output), title);
}

export function buildFeatureInferenceRequest(
  title: string,
  markdown: string,
): FeatureInferenceRequest {
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `输入标题：${title}\n\n输入正文：\n${markdown}\n\n严格输出结构：\n{"title":"标题","author":"机构/研究业务团队（如华泰固收）","summary":"摘要（简练）","importance":70,"keywords":[{"topic":"具体主题","fact":"事实或原文观点","interpretation":"归纳含义","impact":"直接表述受影响的市场、资产或行业及其方向和机制"}]}`,
      },
    ],
    temperature: 0.1,
    seed: 20260812,
    reasoning_effort: "max",
    max_completion_tokens: 4_000,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "article_features",
        strict: true,
        schema: ARTICLE_FEATURE_RESPONSE_SCHEMA,
      },
    },
  };
}

export function validateArticleFeatures(value: unknown, expectedTitle: string): ArticleFeatures {
  const row = objectValue(value, "article features");
  requiredString(row.title, "title", 500);
  const author = optionalString(row.author, "author", 160);
  const summary = requiredString(row.summary, "summary", 600);
  const importance = row.importance;
  if (!Number.isInteger(importance) || (importance as number) < 0 || (importance as number) > 100) {
    throw new Error("importance must be an integer between 0 and 100");
  }
  if (!Array.isArray(row.keywords) || row.keywords.length < 1 || row.keywords.length > MAX_KEYWORDS) {
    throw new Error(`keywords must contain 1-${MAX_KEYWORDS} items`);
  }
  const keywords = row.keywords.map((item, index) => validateKeyword(item, index));
  const topics = new Set(keywords.map((keyword) => keyword.topic));
  if (topics.size !== keywords.length) throw new Error("keyword topics must be unique");
  return { title: expectedTitle, author, summary, importance: importance as number, keywords };
}

export function buildAiSearchMetadata(
  features: ArticleFeatures,
  publishedAt: string,
): Record<string, string> {
  return {
    source: features.author,
    tags: features.keywords.map((keyword) => keyword.topic).join(","),
    importance: String(features.importance),
    published_at: new Date(publishedAt).toISOString(),
  };
}

export function buildR2Metadata(
  features: ArticleFeatures,
  publishedAt: string,
): Record<string, string> {
  return {
    author: features.author,
    summary: features.summary,
    importance: String(features.importance),
    keywords: features.keywords.map((keyword) => keyword.topic).join(","),
    published_at: new Date(publishedAt).toISOString(),
  };
}

export async function saveArticleFeatures(
  database: D1Database,
  articleId: string,
  features: ArticleFeatures,
  updatedAt: string,
): Promise<void> {
  const results = await database.batch(
    featureStatements(
      database,
      database
        .prepare(`
          UPDATE article
          SET author = ?, summary = ?, importance = ?, prompt_version = ?, updated_at = ?
          WHERE id = ?
        `)
        .bind(
          features.author,
          features.summary,
          features.importance,
          ARTICLE_FEATURE_PROMPT_VERSION,
          updatedAt,
          articleId,
        ),
      articleId,
      features,
    ),
  );
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new Error(`article not found while storing features: ${articleId}`);
  }
}

function featureStatements(
  database: D1Database,
  update: D1PreparedStatement,
  articleId: string,
  features: ArticleFeatures,
): D1PreparedStatement[] {
  return [
    update,
    database.prepare("DELETE FROM keyword WHERE article_id = ?").bind(articleId),
    ...features.keywords.map((keyword, ordinal) =>
      database
        .prepare(`
          INSERT INTO keyword (article_id, ordinal, topic, fact, interpretation, impact)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind(
          articleId,
          ordinal,
          keyword.topic,
          keyword.fact,
          keyword.interpretation,
          keyword.impact,
        ),
    ),
  ];
}

function extractInferencePayload(output: unknown): unknown {
  if (typeof output === "string") return parseJson(output);
  const row = objectValue(output, "Workers AI response");
  if (row.response !== undefined) {
    return typeof row.response === "string" ? parseJson(row.response) : row.response;
  }
  if (!Array.isArray(row.choices) || row.choices.length === 0) {
    throw new Error("Workers AI response is missing choices");
  }
  const choice = objectValue(row.choices[0], "Workers AI choice");
  if (choice.finish_reason === "length") {
    throw new Error("Workers AI response reached the output limit and is incomplete");
  }
  const message = objectValue(choice.message, "Workers AI message");
  if (typeof message.content !== "string" || !message.content.trim()) {
    throw new Error("Workers AI response is missing message content");
  }
  return parseJson(message.content);
}

function parseJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("Workers AI response is not valid JSON");
  }
}

function validateKeyword(value: unknown, index: number): ArticleKeyword {
  const row = objectValue(value, `keywords[${index}]`);
  return {
    topic: requiredString(row.topic, `keywords[${index}].topic`, 40),
    fact: requiredString(row.fact, `keywords[${index}].fact`, 400),
    interpretation: requiredString(row.interpretation, `keywords[${index}].interpretation`, 400),
    impact: requiredString(row.impact, `keywords[${index}].impact`, 500),
  };
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${name} is too long`);
  return normalized;
}

function optionalString(value: unknown, name: string, maxLength: number): string {
  if (value === undefined || value === null || value === "") return "";
  return requiredString(value, name, maxLength);
}
