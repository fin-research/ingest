import { z } from "zod";

const MAX_API_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export const MARKET_COMMENTARY_TAG = "市场解读";
export const ECONOMIC_DATA_POLICY_TAG = "经济数据&政策";
export const CHINA_CENTRAL_BANK_TITLE_PREFIX = "中国央行：";
export const NEWS_PAGE_SIZE = 100;

export interface ArticleMetadata {
  /** DM sentimentId; used as the canonical article identity. */
  id: string;
  newsId?: string;
  title: string;
  publishedAt: string;
}

export interface ArticleDetail {
  content: string;
  link?: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const jsonObjectSchema = z.record(z.string(), z.unknown());
const taggedNewsSchema = z.object({ tags: z.array(z.string()) });
const newsListResponseSchema = z
  .union([
    z.array(z.unknown()),
    z.object({ list: z.array(z.unknown()) }),
  ])
  .transform((value) => Array.isArray(value) ? value : value.list);

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = jsonObjectSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} must be an object`);
  return parsed.data;
}

export function validateArticleMetadata(value: unknown): ArticleMetadata {
  const row = jsonObject(value, "news item");
  const id = optionalString(row.sentimentId ?? row.id, "sentimentId", 200);
  const newsId = optionalString(row.newsId, "newsId", 200);
  if (!id) throw new Error("news item must contain sentimentId");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("article id contains unsupported characters");
  }

  const title = requireString(row.title, "title", 500);
  const publishedAt = requireString(row.time, "time", 64);
  if (Number.isNaN(new Date(publishedAt).valueOf())) {
    throw new Error("time must be an ISO date-time");
  }

  return {
    id,
    ...(newsId ? { newsId } : {}),
    title,
    publishedAt,
  };
}

export function validateArticleDetail(value: unknown): ArticleDetail {
  const row = jsonObject(value, "news detail");
  const link = optionalHttpUrl(row.link, "link", 4_096);
  return {
    content: requireString(row.content, "content", MAX_MARKDOWN_BYTES),
    ...(link ? { link } : {}),
  };
}

export async function fetchResearchReportList(
  apiBaseUrl: string,
  fetcher: Fetcher = fetch,
): Promise<ArticleMetadata[]> {
  return await fetchTaggedNewsList(apiBaseUrl, MARKET_COMMENTARY_TAG, fetcher);
}

export async function fetchCentralBankPolicyNews(
  apiBaseUrl: string,
  fetcher: Fetcher = fetch,
): Promise<ArticleMetadata[]> {
  const articles = await fetchTaggedNewsList(apiBaseUrl, ECONOMIC_DATA_POLICY_TAG, fetcher);
  return articles.filter((article) => article.title.startsWith(CHINA_CENTRAL_BANK_TITLE_PREFIX));
}

async function fetchTaggedNewsList(
  apiBaseUrl: string,
  tag: string,
  fetcher: Fetcher,
): Promise<ArticleMetadata[]> {
  const url = apiUrl(apiBaseUrl, "news");
  url.searchParams.set("tag", tag);
  url.searchParams.set("pageSize", String(NEWS_PAGE_SIZE));
  url.searchParams.set("fields", "sentimentId,newsId,title,time,tags");

  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await readJsonResponse(response, "news list");
  const parsed = newsListResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("news list response must be an array or a legacy list envelope");
  }

  const articles = parsed.data
    .filter((value) => hasExactTag(value, tag))
    .map(validateArticleMetadata);
  return deduplicateArticles(articles);
}

export async function fetchResearchReportDetail(
  apiBaseUrl: string,
  article: ArticleMetadata,
  fetcher: Fetcher = fetch,
): Promise<ArticleDetail> {
  const response = await fetcher(apiUrl(apiBaseUrl, `news/${encodeURIComponent(article.id)}`), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  return validateArticleDetail(await readJsonResponse(response, "news detail"));
}

export function workflowInstanceId(article: ArticleMetadata): string {
  return `article-${article.id}`;
}

export function articleObjectKey(article: ArticleMetadata): string {
  return `${shanghaiDate(article.publishedAt)}/${sanitizeFilename(article.title)}.md`;
}

export function buildArticleMarkdown(article: ArticleMetadata, detail: ArticleDetail): string {
  const markdown = `# ${article.title}\n\n${detail.content.trim()}\n`;
  assertMarkdownFits(markdown);
  return markdown;
}

export function prepareAiSearchMarkdown(markdown: string): string {
  const prepared = addChinesePunctuationSpaces(markdown);
  assertMarkdownFits(prepared);
  return prepared;
}

export function assertMarkdownFits(markdown: string): void {
  const size = new TextEncoder().encode(markdown).byteLength;
  if (size > MAX_MARKDOWN_BYTES) {
    throw new Error(`article Markdown exceeds AI Search limit: ${size} bytes`);
  }
}

function hasExactTag(value: unknown, tag: string): boolean {
  const parsed = taggedNewsSchema.safeParse(value);
  return parsed.success && parsed.data.tags.includes(tag);
}

function deduplicateArticles(articles: ArticleMetadata[]): ArticleMetadata[] {
  const unique = new Map<string, ArticleMetadata>();
  for (const article of articles) unique.set(article.id, article);
  return [...unique.values()];
}

async function readJsonResponse(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status}`);
  }
  const text = await readTextBounded(response, MAX_API_RESPONSE_BYTES, label);
  try {
    const payload: unknown = JSON.parse(text);
    return payload;
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

export async function readTextBounded(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
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

export function addChinesePunctuationSpaces(text: string): string {
  return text.replace(/([。！？；，、：])(?!(?: |　))/g, "$1 ");
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

function optionalHttpUrl(value: unknown, name: string, maxLength: number): string | undefined {
  const normalized = optionalString(value, name, maxLength);
  if (!normalized) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${name} must be an HTTP(S) URL`);
  }
  if (!parsed.hostname || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new Error(`${name} must be an HTTP(S) URL`);
  }
  return normalized;
}

export type { Fetcher, NewsListResponse };
