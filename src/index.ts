import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import {
  articleObjectKey,
  buildArticleMarkdown,
  fetchResearchReportDetail,
  prepareAiSearchMarkdown,
  type ArticleMetadata,
  validateArticleMetadata,
} from "./article";
import { uploadAndWaitForAiSearch } from "./ai-search";
import { collectResearchReports, updateArticleLink } from "./ingest";
import { resolveArticleContent } from "./wechat";

const AI_SEARCH_POLL_TIMEOUT_MS = 8 * 60 * 1000;
const AI_SEARCH_POLL_INTERVAL_MS = 5_000;

export class ArticleWorkflow extends WorkflowEntrypoint<Env, ArticleMetadata> {
  override async run(event: Readonly<WorkflowEvent<ArticleMetadata>>, step: WorkflowStep) {
    const article = validateArticleMetadata({
      ...event.payload,
      time: event.payload.publishedAt,
    });
    const key = articleObjectKey(article);

    const document = await step.do(
      "download and process article text",
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => {
        const detail = await fetchResearchReportDetail(this.env.ARTICLE_API_BASE_URL, article);
        if (detail.link) await updateArticleLink(this.env.DB, article.articleId, detail.link);
        const content = await resolveArticleContent(detail);
        return new Blob([buildArticleMarkdown(article, { ...detail, content })]).stream();
      },
    );

    const archived = await step.do(
      "store article in R2",
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => {
        const markdown = await new Response(document).arrayBuffer();
        const object = await this.env.ARTICLE_BUCKET.put(key, markdown, {
          httpMetadata: { contentType: "text/markdown; charset=utf-8" },
          customMetadata: articleMetadata(article),
        });
        if (!object) throw new Error(`R2 failed to store ${key}`);
        return { key, etag: object.etag, size: object.size };
      },
    );

    return await step.do(
      "store article in AI Search",
      {
        retries: { limit: 5, delay: "15 seconds", backoff: "exponential" },
        timeout: "10 minutes",
      },
      async () => {
        const object = await this.env.ARTICLE_BUCKET.get(archived.key);
        if (!object || !object.body) throw new Error(`R2 object not found: ${archived.key}`);
        const markdown = prepareAiSearchMarkdown(await object.text());
        const item = await uploadAndWaitForAiSearch(
          this.env.FINANCE_SEARCH.items,
          archived.key,
          markdown,
          {
            metadata: { published_at: new Date(article.publishedAt).toISOString() },
            timeoutMs: AI_SEARCH_POLL_TIMEOUT_MS,
            pollIntervalMs: AI_SEARCH_POLL_INTERVAL_MS,
            fileContentEmptyRetries: 1,
          },
        );
        if (item.status === "error" && item.error === "file_content_empty") {
          throw new NonRetryableError(
            `AI Search indexing did not complete for ${archived.key}: file_content_empty`,
          );
        }
        if (item.status !== "completed") {
          throw new Error(
            `AI Search indexing did not complete for ${archived.key}: ${item.error || item.status}`,
          );
        }
        return { key: archived.key, itemId: item.id, status: item.status };
      },
    );
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ok",
        worker: "ingest",
        workflow: "article",
        source: "市场解读",
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const summary = await collectResearchReports(env, new Date(controller.scheduledTime).toISOString());
    console.log(JSON.stringify({ event: "research_report_ingest", ...summary }));
  },
} satisfies ExportedHandler<Env>;

function articleMetadata(article: ArticleMetadata): Record<string, string> {
  return {
    article_id: article.articleId,
    ...(article.sentimentId ? { sentiment_id: article.sentimentId } : {}),
    ...(article.newsId ? { news_id: article.newsId } : {}),
    published_at: new Date(article.publishedAt).toISOString(),
  };
}
