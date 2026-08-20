export interface AiSearchItemSnapshot {
  id: string;
  key: string;
  status: "completed" | "error" | "skipped" | "queued" | "running" | "outdated";
  error?: string;
  metadata?: Record<string, unknown>;
}

interface AiSearchItemsClient {
  list(params?: {
    page?: number;
    per_page?: number;
    search?: string;
    source?: string;
  }): Promise<{ result: AiSearchItemSnapshot[] }>;
  upload(
    name: string,
    content: ReadableStream | Blob | string,
    options?: { metadata?: Record<string, unknown> },
  ): Promise<AiSearchItemSnapshot>;
  get(itemId: string): { info(): Promise<AiSearchItemSnapshot> };
  delete(itemId: string): Promise<void>;
}

interface UploadAndWaitOptions {
  metadata?: Record<string, unknown>;
  timeoutMs: number;
  pollIntervalMs: number;
  fileContentEmptyRetries: number;
  transientErrorRetries?: number;
  wait?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

const MAX_SAFE_ENCODED_SEARCH_LENGTH = 180;

export async function uploadAndWaitForAiSearch(
  items: AiSearchItemsClient,
  key: string,
  content: ReadableStream | Blob | string,
  options: UploadAndWaitOptions,
): Promise<AiSearchItemSnapshot> {
  const wait = options.wait || ((delayMs: number) => scheduler.wait(delayMs));
  const now = options.now || Date.now;
  const deadline = now() + options.timeoutMs;
  const existing = encodedSearchLength(key) <= MAX_SAFE_ENCODED_SEARCH_LENGTH
    ? await items.list({ search: key, source: "builtin", per_page: 50 })
    : { result: [] };
  let item = existing.result.find((candidate) => candidate.key === key);
  if (!item) {
    item = await items.upload(key, content, { metadata: options.metadata });
  } else if (metadataKeysAreMissing(item.metadata, options.metadata)) {
    item = await items.upload(key, content, { metadata: options.metadata });
  }

  let fileContentEmptyRetries = 0;
  let transientErrorRetries = 0;
  while (true) {
    while (item.status === "queued" || item.status === "running") {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw new Error(`AI Search indexing timed out for ${key} after ${options.timeoutMs}ms`);
      }
      await wait(Math.min(options.pollIntervalMs, remainingMs));
      item = await items.get(item.id).info();
    }

    if (item.status !== "error") {
      return item;
    }

    const retriesFileContentEmpty =
      item.error === "file_content_empty" &&
      fileContentEmptyRetries < options.fileContentEmptyRetries;
    const retriesTransientCapacity =
      item.error === "workers_ai_out_of_capacity_error" &&
      transientErrorRetries < (options.transientErrorRetries ?? 0);
    if (!retriesFileContentEmpty && !retriesTransientCapacity) return item;

    await items.delete(item.id);
    if (retriesFileContentEmpty) {
      fileContentEmptyRetries += 1;
    } else {
      transientErrorRetries += 1;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw new Error(`AI Search indexing timed out for ${key} after ${options.timeoutMs}ms`);
      }
      await wait(Math.min(options.pollIntervalMs, remainingMs));
    }
    item = await items.upload(key, content, { metadata: options.metadata });
  }
}

function encodedSearchLength(value: string): number {
  return encodeURIComponent(value).length;
}

function metadataKeysAreMissing(
  current: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined,
): boolean {
  if (!expected) return false;
  return Object.keys(expected).some(
    (key) =>
      !current
      || !Object.prototype.hasOwnProperty.call(current, key)
      || current[key] === null
      || current[key] === undefined,
  );
}

export type { AiSearchItemsClient, UploadAndWaitOptions };
