const MAX_API_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export const MARKET_COMMENTARY_TAG = "市场解读";
export const NEWS_PAGE_SIZE = 100;

export interface ArticleMetadata {
  articleId: string;
  sentimentId?: string;
  newsId?: string;
  title: string;
  publishedAt: string;
}

export interface ArticleDetail {
  content: string;
}

interface NewsListResponse {
  list: ArticleMetadata[];
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function validateArticleMetadata(value: unknown): ArticleMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("news item must be an object");
  }
  const row = value as Record<string, unknown>;
  const sentimentId = optionalString(row.sentimentId, "sentimentId", 200);
  const newsId = optionalString(row.newsId, "newsId", 200);
  const articleId = sentimentId || newsId;
  if (!articleId) throw new Error("news item must contain sentimentId or newsId");
  if (!/^[A-Za-z0-9_-]+$/.test(articleId)) {
    throw new Error("article id contains unsupported characters");
  }

  const title = requireString(row.title, "title", 500);
  const publishedAt = requireString(row.time, "time", 64);
  if (Number.isNaN(new Date(publishedAt).valueOf())) {
    throw new Error("time must be an ISO date-time");
  }

  return {
    articleId,
    ...(sentimentId ? { sentimentId } : {}),
    ...(newsId ? { newsId } : {}),
    title,
    publishedAt,
  };
}

export function validateArticleDetail(value: unknown): ArticleDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("news detail must be an object");
  }
  const row = value as Record<string, unknown>;
  return { content: requireString(row.content, "content", MAX_MARKDOWN_BYTES) };
}

export async function fetchResearchReportList(
  apiBaseUrl: string,
  fetcher: Fetcher = fetch,
): Promise<ArticleMetadata[]> {
  const url = apiUrl(apiBaseUrl, "news");
  url.searchParams.set("tag", MARKET_COMMENTARY_TAG);
  url.searchParams.set("pageSize", String(NEWS_PAGE_SIZE));

  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await readJsonResponse(response, "news list");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("news list response must be an object");
  }
  const rawList = (payload as Record<string, unknown>).list;
  if (!Array.isArray(rawList)) throw new Error("news list response is missing list");

  const articles = rawList
    .filter(hasMarketCommentaryTag)
    .map(validateArticleMetadata);
  return deduplicateArticles(articles);
}

export async function fetchResearchReportDetail(
  apiBaseUrl: string,
  article: ArticleMetadata,
  fetcher: Fetcher = fetch,
): Promise<ArticleDetail> {
  const detailId = article.sentimentId || article.newsId;
  if (!detailId) throw new Error(`article ${article.articleId} has no detail id`);
  const response = await fetcher(apiUrl(apiBaseUrl, `news/${encodeURIComponent(detailId)}`), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  return validateArticleDetail(await readJsonResponse(response, "news detail"));
}

export function workflowInstanceId(article: ArticleMetadata): string {
  return `article-${article.articleId}`;
}

export function articleObjectKey(article: ArticleMetadata): string {
  return `${shanghaiDate(article.publishedAt)}/${sanitizeFilename(article.title)}.md`;
}

export function buildArticleMarkdown(article: ArticleMetadata, detail: ArticleDetail): string {
  const markdown = addSentenceBoundarySpaces(`# ${article.title}\n\n${detail.content.trim()}\n`);
  assertMarkdownFits(markdown);
  return markdown;
}

export function assertMarkdownFits(markdown: string): void {
  const size = new TextEncoder().encode(markdown).byteLength;
  if (size > MAX_MARKDOWN_BYTES) {
    throw new Error(`article Markdown exceeds AI Search limit: ${size} bytes`);
  }
}

function hasMarketCommentaryTag(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tags = (value as Record<string, unknown>).tags;
  return Array.isArray(tags) && tags.includes(MARKET_COMMENTARY_TAG);
}

function deduplicateArticles(articles: ArticleMetadata[]): ArticleMetadata[] {
  const unique = new Map<string, ArticleMetadata>();
  for (const article of articles) unique.set(article.articleId, article);
  return [...unique.values()];
}

async function readJsonResponse(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status}`);
  }
  const text = await readTextBounded(response, MAX_API_RESPONSE_BYTES, label);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

async function readTextBounded(response: Response, maxBytes: number, label: string): Promise<string> {
  const declared = Number(response.headers.get("Content-Length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${label} response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel(`${label} response is too large`);
      throw new Error(`${label} response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function apiUrl(apiBaseUrl: string, path: string): URL {
  const normalized = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const base = new URL(normalized);
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost") {
    throw new Error("ARTICLE_API_BASE_URL must use HTTPS");
  }
  return new URL(path, base);
}

export function addSentenceBoundarySpaces(text: string): string {
  return text.replace(/([。！？；])(?!(?: |　))/g, "$1 ");
}

function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  const filename = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "untitled";
  return Array.from(filename).slice(0, 180).join("");
}

function shanghaiDate(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${name} is too long`);
  return normalized;
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireString(value, name, maxLength);
}

export type { Fetcher, NewsListResponse };
