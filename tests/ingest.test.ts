import { describe, expect, it } from "vitest";

import type { ArticleMetadata } from "../src/article";
import {
  type ArticleRepository,
  type ArticleWorkflowLauncher,
  runCollection,
} from "../src/ingest";

class MemoryRepository implements ArticleRepository {
  readonly rows = new Map<string, ArticleMetadata>();
  readonly removed: string[][] = [];

  async findExistingIds(ids: string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => this.rows.has(id)));
  }

  async insertIfAbsent(articles: ArticleMetadata[]): Promise<ArticleMetadata[]> {
    const inserted: ArticleMetadata[] = [];
    for (const article of articles) {
      if (this.rows.has(article.articleId)) continue;
      this.rows.set(article.articleId, article);
      inserted.push(article);
    }
    return inserted;
  }

  async remove(ids: string[]): Promise<void> {
    this.removed.push(ids);
    for (const id of ids) this.rows.delete(id);
  }
}

class MemoryWorkflow implements ArticleWorkflowLauncher {
  readonly batches: ArticleMetadata[][] = [];

  async start(articles: ArticleMetadata[]): Promise<string[]> {
    this.batches.push(articles);
    return articles.map((article) => `article-${article.articleId}`);
  }
}

const apiPayload = {
  list: [
    {
      sentimentId: "S1",
      newsId: "N1",
      title: "研报一",
      time: "2026-08-11T09:00:00+08:00",
      tags: ["市场解读"],
    },
    {
      sentimentId: "S2",
      newsId: "N2",
      title: "研报二",
      time: "2026-08-11T09:05:00+08:00",
      tags: ["市场解读"],
    },
  ],
};

const fetcher = async (): Promise<Response> => Response.json(apiPayload);

describe("scheduled ingest", () => {
  it("writes and launches only new articles across repeated scans", async () => {
    const repository = new MemoryRepository();
    const workflow = new MemoryWorkflow();
    const dependencies = {
      apiBaseUrl: "https://eastmoney.hasbai.xyz/api",
      repository,
      workflow,
      fetcher,
    };

    const first = await runCollection(dependencies, "2026-08-11T01:05:00Z");
    const second = await runCollection(dependencies, "2026-08-11T01:10:00Z");

    expect(first).toEqual({ fetched: 2, existing: 0, inserted: 2, workflows: 2 });
    expect(second).toEqual({ fetched: 2, existing: 2, inserted: 0, workflows: 0 });
    expect(workflow.batches).toHaveLength(1);
    expect([...repository.rows]).toHaveLength(2);
  });

  it("removes newly inserted dedupe rows when workflow dispatch fails", async () => {
    const repository = new MemoryRepository();
    const workflow: ArticleWorkflowLauncher = {
      async start(): Promise<string[]> {
        throw new Error("workflow unavailable");
      },
    };

    await expect(
      runCollection(
        {
          apiBaseUrl: "https://eastmoney.hasbai.xyz/api",
          repository,
          workflow,
          fetcher,
        },
        "2026-08-11T01:05:00Z",
      ),
    ).rejects.toThrow("workflow unavailable");

    expect(repository.rows.size).toBe(0);
    expect(repository.removed).toEqual([["S1", "S2"]]);
  });
});
