import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import {
  articleObjectKey,
  buildArticleMarkdown,
  fetchCentralBankPolicyNews,
  fetchResearchReportDetail,
  prepareAiSearchMarkdown,
  type ArticleMetadata,
  validateArticleDetail,
  validateArticleMetadata,
} from "./article";
import { uploadAndWaitForAiSearch } from "./ai-search";
import { generateAiGatewayObject } from "./ai-gateway";
import {
  ARTICLE_FEATURE_PROMPT_VERSION,
  buildAiSearchMetadata,
  buildR2Metadata,
  extractArticleFeatures,
  saveArticleFeatures,
} from "./feature-extraction";
import { collectResearchReports, updateArticleLink } from "./ingest";
import {
  createTelegramNotifier,
  D1TelegramDeliveryRepository,
  runTelegramNotificationWorkflow,
  type TelegramCollectionSummary,
} from "./telegram";
import { isWechatArticleLink, resolveArticleContent } from "./wechat";

export const AI_SEARCH_POLL_TIMEOUT_MS = 8 * 60 * 1000;
export const AI_SEARCH_POLL_INTERVAL_MS = 15_000;

export class ArticleWorkflow extends WorkflowEntrypoint<Env, ArticleMetadata> {
  override async run(event: Readonly<WorkflowEvent<ArticleMetadata>>, step: WorkflowStep) {
    const article = validateArticleMetadata({
      ...event.payload,
      time: event.payload.publishedAt,
    });
    const key = articleObjectKey(article);

    const detailStream = await step.do(
      "download article from DM",
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => {
        const detail = await fetchResearchReportDetail(this.env.ARTICLE_API_BASE_URL, article);
        if (detail.link) await updateArticleLink(this.env.DB, article.id, detail.link);
        return new Blob([JSON.stringify(detail)]).stream();
      },
    );
    const detail = validateArticleDetail(await new Response(detailStream).json());

    const documentStream = isWechatArticleLink(detail.link || "")
      ? await step.do(
          "download WeChat article",
          {
            retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
            timeout: "2 minutes",
          },
          async () => {
            const content = await resolveArticleContent(detail);
            return markdownStream(article, { ...detail, content });
          },
        )
      : markdownStream(article, detail);
    const markdown = await new Response(documentStream).text();

    const extracted = await step.do(
      "extract article features with Responses API",
      { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => {
        return await extractArticleFeatures(
          async (input) =>
            await generateAiGatewayObject(
              {
                accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
                gatewayId: this.env.AI_GATEWAY_ID,
                token: this.env.CF_AIG_TOKEN,
              },
              input.messages,
              input.schema,
              input.schemaName,
              {
                promptCacheKey: input.promptCacheKey,
                requestTimeoutMs: 120_000,
                taskType: input.taskType,
                metadata: {
                  article_id: article.id,
                  prompt_version: ARTICLE_FEATURE_PROMPT_VERSION,
                  tags: "eastmoney,feature-extraction,model:gpt-5.6-luna",
                },
              },
            ),
          article.title,
          markdown,
        );
      },
    );

    await step.do(
      "store article features in D1",
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => {
        await saveArticleFeatures(this.env.DB, article.id, extracted, new Date().toISOString());
        return { articleId: article.id, keywordCount: extracted.keywords.length };
      },
    );

    const archived = await step.do(
      "store article in R2",
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => {
        const object = await this.env.ARTICLE_BUCKET.put(key, markdown, {
          httpMetadata: { contentType: "text/markdown; charset=utf-8" },
          customMetadata: buildR2Metadata(extracted, article.publishedAt),
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
            metadata: buildAiSearchMetadata(extracted, article.publishedAt),
            timeoutMs: AI_SEARCH_POLL_TIMEOUT_MS,
            pollIntervalMs: AI_SEARCH_POLL_INTERVAL_MS,
            fileContentEmptyRetries: 1,
            transientErrorRetries: 2,
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

export class TelegramWorkflow extends WorkflowEntrypoint<Env, Record<string, never>> {
  override async run(
    event: Readonly<WorkflowEvent<Record<string, never>>>,
    step: WorkflowStep,
  ): Promise<TelegramCollectionSummary> {
    const sentAt = new Date(event.schedule?.scheduledTime ?? event.timestamp).toISOString();
    const repository = new D1TelegramDeliveryRepository(this.env.DB);
    const summary = await runTelegramNotificationWorkflow({
      fetchArticles: async () => await step.do(
        "fetch central bank policy news",
        {
          retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        },
        async () => await fetchCentralBankPolicyNews(this.env.ARTICLE_API_BASE_URL),
      ),
      findDeliveredIds: async (ids) => new Set(await step.do(
        "find delivered Telegram notifications",
        {
          retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        },
        async () => [...await repository.findDeliveredIds(ids)],
      )),
      send: async (article) => await step.do(
        `send Telegram notification ${article.id}`,
        {
          retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
          timeout: "1 minute",
        },
        async () => {
          const notifier = await createTelegramNotifier(this.env);
          return await notifier.send(article);
        },
      ),
      markDelivered: async (article, messageId) => {
        await step.do(
          `record Telegram delivery ${article.id}`,
          {
            retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
            timeout: "2 minutes",
          },
          async () => {
            await repository.markDelivered(article, sentAt, messageId);
            return { articleId: article.id, messageId };
          },
        );
      },
    });
    console.log(JSON.stringify({
      event: "central_bank_telegram_notifications",
      workflowInstanceId: event.instanceId,
      ...summary,
    }));
    return summary;
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
        telegramWorkflow: "telegram",
        source: "市场解读",
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const scheduledAt = new Date(controller.scheduledTime).toISOString();
    try {
      const summary = await collectResearchReports(env, scheduledAt);
      console.log(JSON.stringify({ event: "research_report_ingest", ...summary }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "research_report_ingest_failed",
        error: errorMessage(error),
      }));
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;

function markdownStream(
  article: ArticleMetadata,
  detail: Parameters<typeof buildArticleMarkdown>[1],
): ReadableStream<Uint8Array> {
  return new Blob([buildArticleMarkdown(article, detail)]).stream();
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Unknown error";
}
