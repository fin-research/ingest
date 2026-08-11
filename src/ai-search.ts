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
    options?: { metadata?: Record<string, unknown> },
  ): Promise<AiSearchItemSnapshot>;
  get(itemId: string): { info(): Promise<AiSearchItemSnapshot> };
}

interface UploadAndWaitOptions {
  metadata?: Record<string, unknown>;
  timeoutMs: number;
  pollIntervalMs: number;
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

  while (item.status === "queued" || item.status === "running") {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error(`AI Search indexing timed out for ${key} after ${options.timeoutMs}ms`);
    }
    await wait(Math.min(options.pollIntervalMs, remainingMs));
    item = await items.get(item.id).info();
  }

  return item;
}

export type { AiSearchItemsClient, UploadAndWaitOptions };
