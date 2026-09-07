import { readFile } from "node:fs/promises";
import { z } from "zod";
export const itemSchema = z.object({
  id: z.string(), key: z.string(), source_id: z.string(), status: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(), error: z.string().nullable().optional(),
}).passthrough();
type Item = z.infer<typeof itemSchema>;
export const objectSchema = z.object({ key: z.string(), etag: z.string(), size: z.number(), custom_metadata: z.record(z.string(), z.string()).optional() }).passthrough();

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export function createMaintenanceClient(credentials: string) {
  const base = "https://api.cloudflare.com/client/v4/accounts/5cecc63c78acf8f5473f8745f4244448";
async function auth() {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? (await readFile(credentials, "utf8")).match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
  if (!token) throw new Error("Missing Cloudflare credentials");
  return token;
}

async function request(path: string, method = "GET", body?: unknown): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(base + path, { method,
        headers: { Authorization: `Bearer ${await auth()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000),
      });
      if (response.ok) return response;
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** attempt));
        continue;
      }
      await response.body?.cancel();
      throw new HttpError(`${method} ${path}: HTTP ${response.status}`, response.status);
    } catch (error) {
      if (attempt >= 4 || method === "POST" || (error instanceof HttpError && error.status < 500 && error.status !== 429)) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** attempt));
    }
  }
}
async function json(path: string, method = "GET", body?: unknown) {
  const result: unknown = await (await request(path, method, body)).json();
  const envelope = z.object({ success: z.boolean(), result: z.unknown(), result_info: z.object({ total_count: z.number().optional(), cursor: z.string().optional(), is_truncated: z.boolean().optional() }).passthrough().optional() }).passthrough().parse(result);
  if (!envelope.success) throw new Error(`${method} ${path}: API success=false`);
  return envelope;
}
async function listItems(path: string) {
  const byId = new Map<string, Item>();
  for (let page = 1; ; page++) {
    const response = await json(`${path}/items?per_page=50&page=${page}`);
    const items = z.array(itemSchema).parse(response.result);
    for (const item of items) byId.set(item.id, item);
    if (items.length < 50 || page * 50 >= (response.result_info?.total_count ?? Infinity)) break;
  }
  return [...byId.values()];
}
async function listObjects() {
  const objects: z.infer<typeof objectSchema>[] = [];
  let cursor = "";
  do {
    const response = await json(`/r2/buckets/article/objects?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    objects.push(...z.array(objectSchema).parse(response.result));
    cursor = response.result_info?.is_truncated ? response.result_info.cursor ?? "" : "";
  } while (cursor);
  return objects;
}

return { request, json, listItems, listObjects };
}
export async function bodyBytes(response: Response) {
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try { while (true) {
    const value = await reader.read(); if (value.done) break;
    size += value.value.byteLength;
    if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("Article exceeds 4 MiB"); }
    chunks.push(value.value);
  } } finally { reader.releaseLock(); }
  if (size === 0) throw new Error("Empty article download");
  return Buffer.concat(chunks);
}
