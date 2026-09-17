import { describe, expect, it } from "vitest";

import type { ArticleMetadata } from "../src/article";
import {
  formatCentralBankNotification,
  runCentralBankNotificationCollection,
  MessengerNotifier,
  telegramWorkflowInstanceId,
  type TelegramDeliveryRepository,
  type TelegramWorkflowLauncher,
} from "../src/telegram";

const policyNews = {
  sentimentId: "2026082500010679999",
  newsId: "policy-news-1",
  title: "中国央行：今日开展公开市场操作",
  time: "2026-08-25T08:31:09+08:00",
  tags: ["经济数据&政策", "货币政策"],
};
const secondPolicyNews = {
  ...policyNews,
  sentimentId: "2026082500010680000",
  newsId: "policy-news-2",
  title: "中国央行：今日开展另一项公开市场操作",
};

class MemoryDeliveryRepository implements TelegramDeliveryRepository {
  readonly rows = new Map<string, {
    article: ArticleMetadata;
    discoveredAt: string;
    workflowInstanceId: string;
    messageId?: number;
  }>();

  async findExistingIds(ids: string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => this.rows.has(id)));
  }

  async insertPending(
    articles: ArticleMetadata[],
    discoveredAt: string,
    workflowInstanceId: string,
  ): Promise<ArticleMetadata[]> {
    for (const article of articles) {
      if (this.rows.has(article.id)) continue;
      this.rows.set(article.id, { article, discoveredAt, workflowInstanceId });
    }
    return articles.filter((article) => {
      const row = this.rows.get(article.id);
      return row?.workflowInstanceId === workflowInstanceId && row.messageId === undefined;
    });
  }

  async findDeliveredMessageIds(ids: string[]): Promise<Map<string, number>> {
    const delivered = new Map<string, number>();
    for (const id of ids) {
      const messageId = this.rows.get(id)?.messageId;
      if (messageId !== undefined) delivered.set(id, messageId);
    }
    return delivered;
  }

  async markDelivered(articleId: string, _sentAt: string, messageId: number): Promise<void> {
    const row = this.rows.get(articleId);
    if (!row) throw new Error(`missing ${articleId}`);
    row.messageId = messageId;
  }
}

class MemoryWorkflow implements TelegramWorkflowLauncher {
  readonly batches: Array<{ articles: ArticleMetadata[]; discoveredAt: string }> = [];

  async start(articles: ArticleMetadata[], discoveredAt: string): Promise<string> {
    this.batches.push({ articles, discoveredAt });
    return telegramWorkflowInstanceId(discoveredAt);
  }
}

describe("central bank Telegram notifications", () => {
  it("dispatches one workflow only after fetching and deduplicating new news", async () => {
    const repository = new MemoryDeliveryRepository();
    const workflow = new MemoryWorkflow();
    const dependencies = {
      apiBaseUrl: "https://eastmoney.hasbai.xyz/data",
      repository,
      workflow,
      fetcher: async (): Promise<Response> => Response.json([
        policyNews,
        secondPolicyNews,
      ]),
    };

    const first = await runCentralBankNotificationCollection(
      dependencies,
      "2026-08-25T00:35:00Z",
    );
    const queued = workflow.batches[0]?.articles || [];
    await repository.insertPending(
      queued,
      "2026-08-25T00:35:00Z",
      "telegram-1787618100000",
    );
    const second = await runCentralBankNotificationCollection(
      dependencies,
      "2026-08-25T00:40:00Z",
    );

    expect(first).toEqual({ matched: 2, existing: 0, queued: 2, workflows: 1 });
    expect(second).toEqual({ matched: 2, existing: 2, queued: 0, workflows: 0 });
    expect(workflow.batches).toHaveLength(1);
    expect(workflow.batches[0]?.articles.map((article) => article.id)).toEqual([
      policyNews.sentimentId,
      secondPolicyNews.sentimentId,
    ]);
  });

  it("does not insert a pending row when workflow dispatch fails", async () => {
    const repository = new MemoryDeliveryRepository();
    await expect(
      runCentralBankNotificationCollection(
        {
          apiBaseUrl: "https://eastmoney.hasbai.xyz/data",
          repository,
          fetcher: async (): Promise<Response> => Response.json([policyNews]),
          workflow: {
            async start(): Promise<string> {
              throw new Error("workflow unavailable");
            },
          },
        },
        "2026-08-25T00:35:00Z",
      ),
    ).rejects.toThrow("workflow unavailable");

    expect(repository.rows.size).toBe(0);
  });

  it("builds a stable workflow id from the Cron timestamp", () => {
    expect(telegramWorkflowInstanceId("2026-08-25T00:35:00Z")).toBe(
      "telegram-1787618100000",
    );
  });

  it("keeps a pending notification owned by the first workflow across retries", async () => {
    const repository = new MemoryDeliveryRepository();
    const article = {
      id: policyNews.sentimentId,
      newsId: policyNews.newsId,
      title: policyNews.title,
      publishedAt: policyNews.time,
    };

    await expect(repository.insertPending(
      [article],
      "2026-08-25T00:35:00Z",
      "telegram-first",
    )).resolves.toEqual([article]);
    await expect(repository.insertPending(
      [article],
      "2026-08-25T00:35:00Z",
      "telegram-first",
    )).resolves.toEqual([article]);
    await expect(repository.insertPending(
      [article],
      "2026-08-25T00:40:00Z",
      "telegram-second",
    )).resolves.toEqual([]);
  });

  it("submits stable business keys through the private messenger binding", async () => {
    let payload: any;
    const notifier = new MessengerNotifier({fetch: async request => {
      payload=await request.json();return Response.json({id:'message-1',status:'queued'});
    }});
    const result=await notifier.send({id:policyNews.sentimentId,title:policyNews.title,publishedAt:policyNews.time});
    expect(result).toBe('message-1');expect(payload).toEqual({source:'ingest',channel:'telegram',idempotencyKey:`central-bank/${policyNews.sentimentId}`,text:'中国央行：今日开展公开市场操作\n发布时间：2026-08-25 08:31'});
  });
  it("rejects failed or malformed messenger submissions without marking sent",async()=>{
    const article={id:policyNews.sentimentId,title:policyNews.title,publishedAt:policyNews.time};
    await expect(new MessengerNotifier({fetch:async()=>Response.json({}, {status:503})}).send(article)).rejects.toThrow('503');
    await expect(new MessengerNotifier({fetch:async()=>Response.json({})}).send(article)).rejects.toThrow('missing id');
  });

  it("formats the source title without Telegram markup", () => {
    expect(formatCentralBankNotification({
      id: policyNews.sentimentId,
      title: "中国央行：下调<某工具>利率 & 观察",
      publishedAt: policyNews.time,
    })).toBe("中国央行：下调<某工具>利率 & 观察\n发布时间：2026-08-25 08:31");
  });
});
