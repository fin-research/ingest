import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import {
  articleObjectKey,
  buildArticleMarkdown,
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
  associateArticleWithPolicies,
  associatePoliciesWithArticles,
  collectPolicies,
  D1PolicyNewsRepository,
  generatePolicyAggregation,
  loadPolicyEvidence,
  type PolicyWorkflowParams,
  type PolicyWorkflowSummary,
} from "./policy";
import {
  collectCentralBankNotifications,
  createTelegramNotifier,
  D1TelegramDeliveryRepository,
  type TelegramDeliverySummary,
  type TelegramWorkflowParams,
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

    await step.do(
      "associate article with recent policies",
      { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => await associateArticleWithPolicies(this.env, article.id),
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

export class TelegramWorkflow extends WorkflowEntrypoint<Env, TelegramWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<TelegramWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<TelegramDeliverySummary> {
    const discoveredAt = requireIsoDateTime(
      event.payload.discoveredAt,
      "Telegram discoveredAt",
    );
    if (!Array.isArray(event.payload.articles)) {
      throw new Error("Telegram articles must be an array");
    }
    const articles = event.payload.articles.map((article) => validateArticleMetadata({
      ...article,
      time: article.publishedAt,
    }));
    const repository = new D1TelegramDeliveryRepository(this.env.DB);
    const stored = await step.do(
      "store Telegram notifications",
      {
        retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      },
      async () => await repository.insertPending(articles, discoveredAt, event.instanceId),
    );
    if (stored.length === 0) {
      return { stored: 0, sent: 0, alreadySent: 0, deliveries: [] };
    }

    const summary = await step.do(
      "send Telegram notifications",
      {
        retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
        timeout: "5 minutes",
      },
      async () => {
        const delivered = await repository.findDeliveredMessageIds(
          stored.map((article) => article.id),
        );
        const deliveries = [...delivered].map(([articleId, messageId]) => ({
          articleId,
          messageId,
        }));
        let sent = 0;
        let notifier: Awaited<ReturnType<typeof createTelegramNotifier>> | undefined;

        for (const article of stored) {
          if (delivered.has(article.id)) continue;
          notifier ??= await createTelegramNotifier(this.env);
          let messageId: number;
          try {
            messageId = await notifier.send(article);
          } catch (error) {
            throw new Error(
              `Telegram notification failed for article ${article.id}: ${errorMessage(error)}`,
            );
          }
          await repository.markDelivered(article.id, new Date().toISOString(), messageId);
          deliveries.push({ articleId: article.id, messageId });
          sent += 1;
        }

        return {
          stored: stored.length,
          sent,
          alreadySent: delivered.size,
          deliveries,
        };
      },
    );
    console.log(JSON.stringify({
      event: "central_bank_telegram_notifications",
      workflowInstanceId: event.instanceId,
      ...summary,
    }));
    return summary;
  }
}

export class PolicyWorkflow extends WorkflowEntrypoint<Env, PolicyWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<PolicyWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<PolicyWorkflowSummary> {
    if (event.payload.workflowInstanceId !== event.instanceId) {
      throw new Error("Policy workflow payload does not match its instance ID");
    }
    const repository = new D1PolicyNewsRepository(this.env.DB);
    const evidenceStream = await step.do(
      "download central policy news",
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => {
        const claimed = await repository.loadClaimed(event.instanceId);
        if (claimed.length === 0) throw new Error("Policy workflow has no claimed news");
        const evidence = await loadPolicyEvidence(this.env.ARTICLE_API_BASE_URL, claimed);
        return new Blob([JSON.stringify(evidence)]).stream();
      },
    );
    const evidence = JSON.parse(await new Response(evidenceStream).text());
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new Error("Policy workflow evidence is invalid");
    }

    const aggregation = await step.do(
      "aggregate central policy news with Responses API",
      { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => {
        const existing = await repository.loadRecentPolicies(evidence[0].publishedAt);
        return await generatePolicyAggregation(
          {
            accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
            gatewayId: this.env.AI_GATEWAY_ID,
            token: this.env.CF_AIG_TOKEN,
          },
          evidence,
          existing,
        );
      },
    );

    const summary = await step.do(
      "store policy aggregation in D1",
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => await repository.saveAggregation(
        event.instanceId,
        evidence,
        aggregation,
        new Date().toISOString(),
      ),
    );
    const associations = await step.do(
      "associate policies with existing articles",
      { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => await associatePoliciesWithArticles(this.env, summary.policyIds),
    );
    console.log(JSON.stringify({
      event: "central_policy_aggregation",
      workflowInstanceId: event.instanceId,
      ...summary,
      articleAssociations: associations,
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
        policyWorkflow: "policy-aggregation",
        source: "市场解读",
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const scheduledAt = new Date(controller.scheduledTime).toISOString();
    const results = await Promise.allSettled([
      collectResearchReports(env, scheduledAt),
      collectCentralBankNotifications(env, scheduledAt),
      collectPolicies(env, scheduledAt),
    ]);
    const [researchReports, telegramNotifications, policies] = results;

    if (researchReports?.status === "fulfilled") {
      console.log(JSON.stringify({ event: "research_report_ingest", ...researchReports.value }));
    } else {
      console.error(JSON.stringify({
        event: "research_report_ingest_failed",
        error: errorMessage(researchReports?.reason),
      }));
    }

    if (policies?.status === "fulfilled") {
      console.log(JSON.stringify({ event: "central_policy_collection", ...policies.value }));
    } else {
      console.error(JSON.stringify({
        event: "central_policy_collection_failed",
        error: errorMessage(policies?.reason),
      }));
    }

    if (telegramNotifications?.status === "fulfilled") {
      console.log(JSON.stringify({
        event: "central_bank_telegram_collection",
        ...telegramNotifications.value,
      }));
    } else {
      console.error(JSON.stringify({
        event: "central_bank_telegram_collection_failed",
        error: errorMessage(telegramNotifications?.reason),
      }));
    }

    const failed = results
      .map((result, index) => result.status === "rejected"
        ? ["research_reports", "telegram_collection", "policy_collection"][index]
        : null)
      .filter((name): name is string => name !== null);
    if (failed.length > 0) throw new Error(`scheduled collection failed: ${failed.join(", ")}`);
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

function requireIsoDateTime(value: string, label: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) throw new Error(`${label} must be an ISO date-time`);
  return timestamp.toISOString();
}
