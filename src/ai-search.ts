export interface AiSearchItemSnapshot {
  id: string;
  key: string;
  status: "completed" | "error" | "skipped" | "queued" | "running" | "outdated";
  error?: string;
}

interface AiSearchItemsClient {
  list(params: {
    key: string;
    source: "builtin";
    per_page: number;
  }): Promise<{ result: AiSearchItemSnapshot[] }>;
  upload(
    name: string,
    content: ReadableStream | Blob | string,
    options?: { metadata?: Record<string, string> },
  ): Promise<AiSearchItemSnapshot>;
  get(itemId: string): { info(): Promise<AiSearchItemSnapshot> };
  delete(itemId: string): Promise<void>;
}

interface UploadAndWaitOptions {
  metadata?: Record<string, string>;
  timeoutMs: number;
  pollIntervalMs: number;
  fileContentEmptyRetries: number;
  wait?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

export async function uploadAndWaitForAiSearch(
  items: AiSearchItemsClient,
  key: string,
  content: ReadableStream | Blob | string,
  options: UploadAndWaitOptions,
): Promise<AiSearchItemSnapshot> {
  const wait = options.wait || ((delayMs: number) => scheduler.wait(delayMs));
  const now = options.now || Date.now;
  const deadline = now() + options.timeoutMs;
  const existing = await items.list({ key, source: "builtin", per_page: 1 });
  let item = existing.result[0];
  if (!item) {
    item = await items.upload(key, content, { metadata: options.metadata });
  }

  let fileContentEmptyRetries = 0;
  while (true) {
    while (item.status === "queued" || item.status === "running") {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw new Error(`AI Search indexing timed out for ${key} after ${options.timeoutMs}ms`);
      }
      await wait(Math.min(options.pollIntervalMs, remainingMs));
      item = await items.get(item.id).info();
    }

    if (
      item.status !== "error" ||
      item.error !== "file_content_empty" ||
      fileContentEmptyRetries >= options.fileContentEmptyRetries
    ) {
      return item;
    }

    await items.delete(item.id);
    fileContentEmptyRetries += 1;
    item = await items.upload(key, content, { metadata: options.metadata });
  }
}

export type { AiSearchItemsClient, UploadAndWaitOptions };
