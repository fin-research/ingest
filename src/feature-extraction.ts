export const ARTICLE_FEATURE_MODEL = "@cf/google/gemma-4-26b-a4b-it" as const;
export const ARTICLE_FEATURE_PROMPT_VERSION = "article-features-v4";

const MAX_KEYWORDS = 8;

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
  top_p: number;
  seed: number;
  reasoning_effort: "low";
  chat_template_kwargs: { enable_thinking: false };
  max_completion_tokens: number;
  response_format: { type: "json_object" };
}

export type FeatureInferenceRunner = (request: FeatureInferenceRequest) => Promise<unknown>;

const SYSTEM_PROMPT = `/no_think
你是服务于专业投资者的中国资本市场研报分析员。请从单篇研报中抽取可核验的结构化特征，重点判断其对权益和固收利率的影响。

证据边界：
1. 只能使用输入标题和正文，不得补充外部事实、常识性结论或未被原文支持的预测。
2. fact 必须是原文事实或原文明确观点的简短转述；interpretation 才能写归纳含义，二者不得混淆。
3. author 只提取正文或标题明确出现的发布机构或研究业务团队，不需要精确到个人姓名。例：“国海固收颜子琦团队”输出“国海固收”，“华泰固收张继强团队”输出“华泰固收”；无法确认机构时输出空字符串，不得猜测。
4. title 必须逐字复制输入标题。

统一重要性标准（importance 为 0-100 的整数）：
- 0-20：几乎没有权益或利率定价信息；
- 21-40：背景材料或局部事实，资产影响弱；
- 41-60：给出资产方向或影响机制，但范围有限、证据单一；
- 61-80：包含重要政策、宏观、资金或估值变化，传导清晰且具备交易参考；
- 81-100：重大政策或宏观拐点，证据充分，可能引发显著或跨资产重定价。
单一机构的主观判断不得仅因措辞强烈而获得高分。

关键词规则：
5. 输出 1-8 个互不重复的 keywords，按市场影响的重要性降序。topic 使用 2-12 个汉字或常用市场缩写，必须落到原文中的具体政策操作、数据变化、资金行为、行业线索或定价主题，读者只看 topic 也应知道文章在讨论什么。禁止输出“市场、政策、经济、利率、债券、股票、风险、宏观基本面、外部约束、市场影响、政策预期、货币政策预期”等空泛词；若初步概括仍属于这类上位词，必须继续用原文事实收窄。例如将“货币政策预期”改为“降准降息观察期”“隔夜逆回购重启”或“DR001宽松区间”，具体选择取决于原文证据。
6. 合并同义词、上下位概念和同一因果链中的近义信号。例如“货币政策预期”和“降准降息概率”应合并并收窄为“降准降息预期”；只有事实依据、传导机制或资产影响彼此独立时才拆成多个 topic。
7. interpretation 说明事实背后的定价或传导含义。impact 直接写该事项会影响哪些市场、资产或行业，以及方向和机制，不要套用“权益：……；利率债：……”等固定分栏。相较其他市场，优先分析权益和固收，但只写原文证据能够支持的影响，不强行覆盖两个市场；原文没有足够证据时明确写“证据不足”，不得机械写“中性”。
8. summary 用 80-220 个汉字概括核心结论、主要依据和最重要的资产影响，保持简练。
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
    top_p: 0.85,
    seed: 20260812,
    reasoning_effort: "low",
    chat_template_kwargs: { enable_thinking: false },
    max_completion_tokens: 4_000,
    response_format: { type: "json_object" },
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

export async function saveArticleFeatures(
  database: D1Database,
  articleId: string,
  features: ArticleFeatures,
  extractedAt: string,
): Promise<void> {
  const statements = [
    database
      .prepare(`
        UPDATE article
        SET author = ?, summary = ?, importance = ?, feature_model = ?,
            feature_prompt_version = ?, feature_extracted_at = ?
        WHERE article_id = ?
      `)
      .bind(
        features.author,
        features.summary,
        features.importance,
        ARTICLE_FEATURE_MODEL,
        ARTICLE_FEATURE_PROMPT_VERSION,
        extractedAt,
        articleId,
      ),
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
  const results = await database.batch(statements);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new Error(`article not found while storing features: ${articleId}`);
  }
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
