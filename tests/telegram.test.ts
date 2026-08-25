import { describe, expect, it } from "vitest";

import type { ArticleMetadata } from "../src/article";
import {
  formatCentralBankNotification,
  runCentralBankNotificationCollection,
  TelegramBotNotifier,
  type TelegramDeliveryRepository,
  type TelegramNotifier,
} from "../src/telegram";

const policyNews = {
  sentimentId: "2026082500010679999",
  newsId: "policy-news-1",
  title: "中国央行：今日开展公开市场操作",
  time: "2026-08-25T08:31:09+08:00",
  tags: ["经济数据&政策", "货币政策"],
};

class MemoryDeliveryRepository implements TelegramDeliveryRepository {
  readonly rows = new Map<string, { article: ArticleMetadata; messageId: number }>();

  async findDeliveredIds(ids: string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => this.rows.has(id)));
  }

  async markDelivered(article: ArticleMetadata, _sentAt: string, messageId: number): Promise<void> {
    this.rows.set(article.id, { article, messageId });
  }
}

describe("central bank Telegram notifications", () => {
  it("sends matching news once across repeated scans and lazily creates the notifier", async () => {
    const repository = new MemoryDeliveryRepository();
    const sent: ArticleMetadata[] = [];
    let notifierRequests = 0;
    const dependencies = {
      apiBaseUrl: "https://eastmoney.hasbai.xyz/data",
      repository,
      fetcher: async (): Promise<Response> => Response.json({ list: [policyNews] }),
      getNotifier: async (): Promise<TelegramNotifier> => {
        notifierRequests += 1;
        return {
          async send(article): Promise<number> {
            sent.push(article);
            return 321;
          },
        };
      },
    };

    const first = await runCentralBankNotificationCollection(
      dependencies,
      "2026-08-25T00:35:00Z",
    );
    const second = await runCentralBankNotificationCollection(
      dependencies,
      "2026-08-25T00:40:00Z",
    );

    expect(first).toEqual({ matched: 1, existing: 0, sent: 1 });
    expect(second).toEqual({ matched: 1, existing: 1, sent: 0 });
    expect(notifierRequests).toBe(1);
    expect(sent.map((article) => article.id)).toEqual([policyNews.sentimentId]);
    expect(repository.rows.get(policyNews.sentimentId)?.messageId).toBe(321);
  });

  it("does not mark a delivery when Telegram rejects the send", async () => {
    const repository = new MemoryDeliveryRepository();
    await expect(
      runCentralBankNotificationCollection(
        {
          apiBaseUrl: "https://eastmoney.hasbai.xyz/data",
          repository,
          fetcher: async (): Promise<Response> => Response.json({ list: [policyNews] }),
          getNotifier: async (): Promise<TelegramNotifier> => ({
            async send(): Promise<number> {
              throw new Error("upstream unavailable");
            },
          }),
        },
        "2026-08-25T00:35:00Z",
      ),
    ).rejects.toThrow(`article ${policyNews.sentimentId}: upstream unavailable`);

    expect(repository.rows.size).toBe(0);
  });

  it("posts a bounded plain-text alert to Telegram sendMessage", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const strictFetcher = async function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      expect(this).toBeUndefined();
      requestedUrl = input.toString();
      requestedInit = init;
      return Response.json({ ok: true, result: { message_id: 456 } });
    };
    const notifier = new TelegramBotNotifier("123456:test-token", "789012", strictFetcher);

    const messageId = await notifier.send({
      id: policyNews.sentimentId,
      newsId: policyNews.newsId,
      title: policyNews.title,
      publishedAt: policyNews.time,
    });

    expect(messageId).toBe(456);
    expect(new URL(requestedUrl).origin).toBe("https://api.telegram.org");
    expect(new URL(requestedUrl).pathname.endsWith("/sendMessage")).toBe(true);
    expect(requestedInit?.method).toBe("POST");
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      chat_id: "789012",
      text: "中国央行：今日开展公开市场操作\n发布时间：2026-08-25 08:31",
    });
  });

  it("rejects non-numeric user IDs and malformed Telegram responses", async () => {
    expect(() => new TelegramBotNotifier("123:test", "@channel")).toThrow("numeric");
    const notifier = new TelegramBotNotifier(
      "123:test",
      "456",
      async (): Promise<Response> => Response.json({ ok: true, result: {} }),
    );
    await expect(notifier.send({
      id: policyNews.sentimentId,
      title: policyNews.title,
      publishedAt: policyNews.time,
    })).rejects.toThrow("message_id");
  });

  it("reports Telegram error codes without exposing request credentials", async () => {
    const notifier = new TelegramBotNotifier(
      "123:secret-token",
      "456",
      async (): Promise<Response> => Response.json(
        { ok: false, error_code: 400, description: "Bad Request: chat not found" },
        { status: 400 },
      ),
    );

    const sending = notifier.send({
      id: policyNews.sentimentId,
      title: policyNews.title,
      publishedAt: policyNews.time,
    });
    await expect(sending).rejects.toThrow(
      "Telegram sendMessage failed with HTTP 400, code 400: Bad Request: chat not found",
    );
    await expect(sending).rejects.not.toThrow("secret-token");
  });

  it("redacts bot credentials from Telegram fetch failures", async () => {
    const notifier = new TelegramBotNotifier(
      "123:secret-token",
      "456",
      async (): Promise<Response> => {
        throw new TypeError(
          "Network error at https://api.telegram.org/bot123:secret-token/sendMessage",
        );
      },
    );

    const sending = notifier.send({
      id: policyNews.sentimentId,
      title: policyNews.title,
      publishedAt: policyNews.time,
    });
    await expect(sending).rejects.toThrow(
      "Telegram sendMessage request failed: TypeError: Network error at https://api.telegram.org/bot[REDACTED]/sendMessage",
    );
    await expect(sending).rejects.not.toThrow("secret-token");
  });

  it("formats the source title without Telegram markup", () => {
    expect(formatCentralBankNotification({
      id: policyNews.sentimentId,
      title: "中国央行：下调<某工具>利率 & 观察",
      publishedAt: policyNews.time,
    })).toBe("中国央行：下调<某工具>利率 & 观察\n发布时间：2026-08-25 08:31");
  });
});
