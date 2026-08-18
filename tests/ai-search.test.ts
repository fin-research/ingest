import { describe, expect, it } from "vitest";

import {
  type AiSearchItemSnapshot,
  type AiSearchItemsClient,
  uploadAndWaitForAiSearch,
} from "../src/ai-search";

function item(status: AiSearchItemSnapshot["status"]): AiSearchItemSnapshot {
  return { id: "item-1", key: "2026-08-11/article.md", status };
}

describe("AI Search upload polling", () => {
  it("uploads once and polls with short binding calls until indexing completes", async () => {
    const statuses = [item("running"), item("completed")];
    const waits: number[] = [];
    const uploads: string[] = [];
    const items: AiSearchItemsClient = {
      async list() {
        return { result: [] };
      },
      async upload(key) {
        uploads.push(key);
        return item("queued");
      },
      get() {
        return {
          async info() {
            const next = statuses.shift();
            if (!next) throw new Error("missing test status");
            return next;
          },
        };
      },
      async delete() {},
    };

    const result = await uploadAndWaitForAiSearch(items, "2026-08-11/article.md", "正文。 ", {
      timeoutMs: 480_000,
      pollIntervalMs: 5_000,
      fileContentEmptyRetries: 1,
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
      now: () => 0,
    });

    expect(result.status).toBe("completed");
    expect(uploads).toEqual(["2026-08-11/article.md"]);
    expect(waits).toEqual([5_000, 5_000]);
  });

  it("reuses an existing completed key without uploading it again", async () => {
    let uploads = 0;
    const items: AiSearchItemsClient = {
      async list() {
        return { result: [item("completed")] };
      },
      async upload() {
        uploads += 1;
        return item("queued");
      },
      get() {
        return { info: async () => item("completed") };
      },
      async delete() {},
    };

    const result = await uploadAndWaitForAiSearch(items, "2026-08-11/article.md", "正文。 ", {
      timeoutMs: 480_000,
      pollIntervalMs: 5_000,
      fileContentEmptyRetries: 1,
      wait: async () => undefined,
      now: () => 0,
    });

    expect(result.status).toBe("completed");
    expect(uploads).toBe(0);
  });

  it("deletes and uploads once more after file_content_empty", async () => {
    let uploads = 0;
    const deleted: string[] = [];
    const items: AiSearchItemsClient = {
      async list() {
        return { result: [] };
      },
      async upload() {
        uploads += 1;
        return uploads === 1
          ? { ...item("error"), error: "file_content_empty" }
          : item("completed");
      },
      get() {
        return { info: async () => item("completed") };
      },
      async delete(itemId) {
        deleted.push(itemId);
      },
    };

    const result = await uploadAndWaitForAiSearch(items, "2026-08-11/article.md", "正文。 ", {
      timeoutMs: 480_000,
      pollIntervalMs: 5_000,
      fileContentEmptyRetries: 1,
      wait: async () => undefined,
      now: () => 0,
    });

    expect(result.status).toBe("completed");
    expect(uploads).toBe(2);
    expect(deleted).toEqual(["item-1"]);
  });

  it("backs off and reuploads after a transient Workers AI capacity error", async () => {
    let uploads = 0;
    const waits: number[] = [];
    const deleted: string[] = [];
    const items: AiSearchItemsClient = {
      async list() {
        return {
          result: [
            { ...item("error"), error: "workers_ai_out_of_capacity_error" },
          ],
        };
      },
      async upload() {
        uploads += 1;
        return item("completed");
      },
      get() {
        return { info: async () => item("completed") };
      },
      async delete(itemId) {
        deleted.push(itemId);
      },
    };

    const result = await uploadAndWaitForAiSearch(
      items,
      "2026-08-11/article.md",
      "正文。 ",
      {
        timeoutMs: 480_000,
        pollIntervalMs: 5_000,
        fileContentEmptyRetries: 1,
        transientErrorRetries: 2,
        wait: async (delayMs) => {
          waits.push(delayMs);
        },
        now: () => 0,
      },
    );

    expect(result.status).toBe("completed");
    expect(uploads).toBe(1);
    expect(deleted).toEqual(["item-1"]);
    expect(waits).toEqual([5_000]);
  });

  it("fails after the configured overall polling timeout", async () => {
    let elapsedMs = 0;
    const items: AiSearchItemsClient = {
      async list() {
        return { result: [] };
      },
      async upload() {
        return item("queued");
      },
      get() {
        return { info: async () => item("running") };
      },
      async delete() {},
    };

    await expect(
      uploadAndWaitForAiSearch(items, "2026-08-11/article.md", "正文。 ", {
        timeoutMs: 12_000,
        pollIntervalMs: 5_000,
        fileContentEmptyRetries: 1,
        wait: async (delayMs) => {
          elapsedMs += delayMs;
        },
        now: () => elapsedMs,
      }),
    ).rejects.toThrow("timed out");

    expect(elapsedMs).toBe(12_000);
  });
});
