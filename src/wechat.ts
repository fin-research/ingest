import { readTextBounded, type ArticleDetail, type Fetcher } from "./article";

const MP_ORIGIN = "https://mp.weixin.qq.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36 WAE/1.0";
const MAX_WECHAT_HTML_BYTES = 5 * 1024 * 1024;

export async function resolveArticleContent(
  detail: ArticleDetail,
  fetcher: Fetcher = fetch,
): Promise<string> {
  if (!detail.link || !isWechatArticleLink(detail.link)) return detail.content;

  try {
    return await fetchWechatArticleMarkdown(detail.link, fetcher);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "wechat_article_fallback_to_dm",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return detail.content;
  }
}

export function isWechatArticleLink(link: string): boolean {
  try {
    return new URL(link).hostname.toLowerCase() === "mp.weixin.qq.com";
  } catch {
    return false;
  }
}

export async function fetchWechatArticleMarkdown(
  link: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  if (!isWechatArticleLink(link)) throw new Error("article link is not a WeChat public-account URL");
  const response = await fetcher(link, {
    headers: mpHeaders(),
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`failed to fetch WeChat article HTML: HTTP ${response.status}`);
  }
  const html = await readTextBounded(response, MAX_WECHAT_HTML_BYTES, "WeChat article HTML");
  const markdown = cleanRiskDisclosureMarkdown(htmlToMarkdown(html));
  if (!markdown.trim()) throw new Error("WeChat article Markdown is empty after cleaning");
  return markdown;
}

export function htmlToMarkdown(rawHtml: string): string {
  const normalized = normalizeWechatHtml(rawHtml);
  const markdown = htmlFragmentToMarkdown(normalized);
  if (!markdown) throw new Error("WeChat article Markdown content is empty");
  return markdown;
}

export function htmlFragmentToMarkdown(rawHtml: string): string {
  return renderMarkdown(rawHtml);
}

export function cleanRiskDisclosureMarkdown(markdown: string): string {
  const linkedTextCleaned = cleanMarkdownLinksAndImages(markdown);
  const lines = linkedTextCleaned.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    if (isRiskLine(lines[index] || "")) {
      return lines.slice(0, index).join("\n").trimEnd();
    }
  }
  return linkedTextCleaned;
}

export function cleanMarkdownTextLinks(markdown: string): string {
  let current = markdown;
  let previous = "";
  while (current !== previous) {
    previous = current;
    current = current.replace(/(^|[^!])\[([^\]\r\n]+)\]\([^)]+\)/g, "$1$2");
  }
  return current;
}

export function cleanMarkdownLinksAndImages(markdown: string): string {
  return cleanMarkdownTextLinks(markdown)
    .replace(/!\[[^\]\r\n]*\]\([^)]+\)/g, "")
    .replace(/<https?:\/\/[^>]+>/gi, "")
    .replace(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanPreviouslyProcessedArticleMarkdown(markdown: string): string {
  const cleaned = cleanMarkdownLinksAndImages(markdown);
  if (!cleaned) throw new Error("article Markdown is empty after cleaning links and images");
  return cleaned;
}

function isRiskLine(line: string): boolean {
  const chineseOnly = line.replace(/[^\u4e00-\u9fff]/g, "");
  return (
    chineseOnly.startsWith("风险提示") ||
    chineseOnly.startsWith("风险因素") ||
    chineseOnly.startsWith("免责声明")
  );
}

function mpHeaders(): Headers {
  return new Headers({
    Referer: `${MP_ORIGIN}/`,
    Origin: MP_ORIGIN,
    "User-Agent": USER_AGENT,
    "Accept-Encoding": "identity",
  });
}

function normalizeWechatHtml(rawHtml: string): string {
  const fallback = normalizeFromCgiData(rawHtml);
  if (fallback) return fallback;

  const message = extractWechatError(rawHtml);
  if (message) throw new Error(message);

  const content = extractElementById(rawHtml, "js_content") || extractElementById(rawHtml, "js_article");
  if (!content) throw new Error("WeChat article content is not available");
  return content;
}

function normalizeFromCgiData(rawHtml: string): string | null {
  if (!rawHtml.includes("window.cgiDataNew")) return null;
  const content = getCgiString(rawHtml, "content_noencode") || "";
  if (!content.trim()) return null;
  return looksLikeHtml(content)
    ? content
    : `<p>${escapeHtml(decodeHtmlEntities(content)).replace(/\n/g, "<br>")}</p>`;
}

function getCgiString(rawHtml: string, key: string): string | null {
  const escapedKey = escapeRegExp(key);
  const single = new RegExp(`${escapedKey}\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'`).exec(rawHtml);
  if (single?.[1] !== undefined) return decodeJsString(single[1]);
  const double = new RegExp(`${escapedKey}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(rawHtml);
  if (double?.[1] !== undefined) return decodeJsString(double[1]);
  return null;
}

function decodeJsString(value: string): string {
  return value
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function extractWechatError(rawHtml: string): string | null {
  const title = extractClassText(rawHtml, "weui-msg__title") || extractClassText(rawHtml, "mesg-block");
  if (!title) return null;
  const desc = extractClassText(rawHtml, "weui-msg__desc");
  return [title, desc].filter(Boolean).join(": ");
}

function extractClassText(rawHtml: string, className: string): string {
  const pattern = new RegExp(
    `<[^>]+class=["'][^"']*${escapeRegExp(className)}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "i",
  );
  const match = pattern.exec(rawHtml);
  return match?.[1] !== undefined ? htmlToPlainText(match[1]) : "";
}

function extractElementById(rawHtml: string, id: string): string {
  const idPattern = new RegExp(
    `<([a-zA-Z][\\w:-]*)\\b[^>]*\\bid=["']${escapeRegExp(id)}["'][^>]*>`,
    "i",
  );
  const startMatch = idPattern.exec(rawHtml);
  if (!startMatch || startMatch.index === undefined) return "";

  const tagName = startMatch[1]?.toLowerCase();
  if (!tagName) return "";
  const start = startMatch.index;
  const openEnd = start + startMatch[0].length;
  const end = findElementEnd(rawHtml, tagName, openEnd);
  return end > openEnd ? rawHtml.slice(start, end) : rawHtml.slice(start, openEnd);
}

function findElementEnd(html: string, tagName: string, from: number): number {
  const pattern = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  pattern.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const token = match[0];
    if (token.startsWith("</")) {
      depth--;
      if (depth === 0) return pattern.lastIndex;
    } else if (!token.endsWith("/>")) {
      depth++;
    }
  }
  return -1;
}

function renderMarkdown(html: string): string {
  let value = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  value = value.replace(/<img\b[^>]*>/gi, "");

  value = value.replace(
    /<a\b[^>]*href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, inner: string) => {
      const text = cleanupInline(htmlToPlainText(inner));
      return text;
    },
  );

  value = value
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, inner: string) => `\n\n# ${cleanupInline(htmlToPlainText(inner))}\n\n`)
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, inner: string) => `\n\n## ${cleanupInline(htmlToPlainText(inner))}\n\n`)
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_, inner: string) => `\n\n### ${cleanupInline(htmlToPlainText(inner))}\n\n`)
    .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, (_, inner: string) => `\n\n#### ${cleanupInline(htmlToPlainText(inner))}\n\n`)
    .replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, (_, inner: string) => `\n\n##### ${cleanupInline(htmlToPlainText(inner))}\n\n`)
    .replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, (_, inner: string) => `\n\n###### ${cleanupInline(htmlToPlainText(inner))}\n\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|blockquote|li|ul|ol|tr|table)>/gi, "\n\n")
    .replace(/<(?:p|div|section|article|blockquote|ul|ol|table|tbody|thead|tr|td|th|span|strong|b|em|i)\b[^>]*>/gi, "")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "");

  return cleanupMarkdown(decodeHtmlEntities(value));
}

function htmlToPlainText(html: string): string {
  return cleanupInline(
    decodeHtmlEntities(
      html
        .replace(/<script\b[\s\S]*?<\/script>/gi, "")
        .replace(/<style\b[\s\S]*?<\/style>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function cleanupInline(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t\r\n]+/g, " ").trim();
}

function cleanupMarkdown(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
