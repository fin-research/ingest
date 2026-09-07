/** Run with Node 24+. Credentials and article bodies never enter command output. */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  directory: { type: "string", default: "var/ai-search-r2" },
  credentials: { type: "string", default: `${homedir()}/Library/Preferences/.wrangler/config/default.toml` },
  apply: { type: "boolean", default: false },
  limit: { type: "string" },
  target: { type: "string", default: "finance" },
} });
const command = positionals[0];
if (!["inventory", "backup", "copy", "verify", "cleanup"].includes(command ?? "")) {
  throw new Error("Usage: node scripts/migrate-ai-search-r2.ts inventory|backup|copy|verify|cleanup [--apply] [--limit N]");
}
const directory = resolve(values.directory);
await mkdir(directory, { recursive: true, mode: 0o700 });
const base = "https://api.cloudflare.com/client/v4/accounts/5cecc63c78acf8f5473f8745f4244448";
const sourcePath = "/ai-search/namespaces/default/instances/finance";
if (!/^[a-z0-9_-]+$/.test(values.target)) throw new Error("Invalid target instance");
const targetPath = `/ai-search/namespaces/default/instances/${values.target}`;
const itemSchema = z.object({
  id: z.string(), key: z.string(), source_id: z.string(), status: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(), error: z.string().nullable().optional(),
}).passthrough();
type Item = z.infer<typeof itemSchema>;
const objectSchema = z.object({ key: z.string(), etag: z.string(), size: z.number(), custom_metadata: z.record(z.string(), z.string()).optional() }).passthrough();
const inventorySchema = z.object({ items: z.array(itemSchema), objects: z.array(objectSchema) });
const file = (name: string) => resolve(directory, name);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const objectPath = (key: string) => "/r2/buckets/article/objects/" + key.split("/").map(encodeURIComponent).join("/");
async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
async function save(name: string, value: unknown) { await writeFile(file(name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); }
async function auth() {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? (await readFile(values.credentials, "utf8")).match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
  if (!token) throw new Error("Missing Cloudflare credentials");
  return token;
}
class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
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
async function bodyBytes(response: Response) {
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
async function each<T>(entries: T[], operation: (value: T) => Promise<void>) {
  let next = 0, complete = 0;
  const errors: string[] = [];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < entries.length) {
      const index = next++;
      try { await operation(entries[index]!); } catch (error) { errors.push(`${index}: ${error instanceof Error ? error.message : "Unknown error"}`); }
      complete++;
      if (complete % 100 === 0 || complete === entries.length) console.log(JSON.stringify({ command, complete, total: entries.length, errors: errors.length }));
    }
  }));
  if (errors.length) { await save(`${command}-errors.json`, errors); throw new Error(`${errors.length} failures; see ${command}-errors.json`); }
}

if (command === "inventory") {
  const [items, objects] = await Promise.all([listItems(sourcePath), listObjects()]);
  await save("inventory.json", { items, objects });
  const keys = new Set(objects.map(object => object.key));
  const entries = items.filter(item => item.source_id === "builtin").map(item => ({
    itemId: item.id, key: item.key,
    r2Key: keys.has(item.key) ? item.key : keys.has(item.key.replaceAll("%22", '"')) ? item.key.replaceAll("%22", '"') : item.key,
  }));
  await save("manifest.json", entries);
  console.log(JSON.stringify({ items: items.length, objects: objects.length, missingInR2: entries.filter(entry => !keys.has(entry.r2Key)).length, aliases: entries.filter(entry => entry.key !== entry.r2Key).length }));
} else if (command === "backup") {
  const inventory = inventorySchema.parse(JSON.parse(await readFile(file("inventory.json"), "utf8")));
  await mkdir(file("builtin"), { recursive: true, mode: 0o700 });
  await mkdir(file("r2-original"), { recursive: true, mode: 0o700 });
  await each(inventory.items.filter(item => item.source_id === "builtin"), async item => {
    const path = file(`builtin/${item.id}.md`);
    if (!await exists(path)) await writeFile(path, await bodyBytes(await request(`${sourcePath}/items/${item.id}/download`)), { mode: 0o600 });
  });
  await each(inventory.objects, async object => {
    const path = file(`r2-original/${sha(object.key)}.md`);
    if (await exists(path)) return;
    let content: Buffer;
    try {
      content = await bodyBytes(await request(objectPath(object.key)));
    } catch (error) {
      // The management endpoint cannot retrieve some legacy '?' keys. Recover
      // only an exact original whose bytes match R2's recorded MD5 ETag.
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      const item = inventory.items.find(item => item.key === object.key);
      if (!item) throw error;
      const uploaded = await readFile(file(`builtin/${item.id}.md`), "utf8");
      let recovered: Buffer | undefined;
      for (let mask = 0; mask < 128; mask++) {
        const punctuation = [..."。！？；，、："].filter((_, index) => mask & (1 << index)).join("");
        const candidate = Buffer.from(punctuation ? uploaded.replace(new RegExp(`([${punctuation}]) `, "g"), "$1") : uploaded);
        if (createHash("md5").update(candidate).digest("hex") === object.etag) { recovered = candidate; break; }
      }
      if (!recovered) throw new Error(`Cannot recover exact original for ${object.key}`);
      content = recovered;
    }
    if (createHash("md5").update(content).digest("hex") !== object.etag) throw new Error("R2 changed since inventory; refresh the inventory before migration");
    await writeFile(path, content, { mode: 0o600 });
  });
  const hashes = [];
  for (const item of inventory.items.filter(item => item.source_id === "builtin")) hashes.push({ itemId: item.id, key: item.key, sha256: sha(await readFile(file(`builtin/${item.id}.md`))) });
  await save("backup-hashes.json", hashes);
} else if (command === "copy") {
  if (!values.apply) throw new Error("copy requires --apply after backup");
  const entries = z.array(z.object({ itemId: z.string(), key: z.string(), r2Key: z.string(), preferExistingEtag: z.string().optional() })).parse(JSON.parse(await readFile(file("manifest.json"), "utf8")));
  const hashes = z.array(z.object({ itemId: z.string(), sha256: z.string() })).parse(JSON.parse(await readFile(file("backup-hashes.json"), "utf8")));
  const selected = values.limit ? entries.slice(0, Number(values.limit)) : entries;
  const batches = [];
  for (let index = 0; index < selected.length; index += 25) {
    const items = selected.slice(index, index + 25);
    for (const item of items) if (hashes.find(hash => hash.itemId === item.itemId)?.sha256 !== sha(await readFile(file(`builtin/${item.itemId}.md`)))) throw new Error("Missing or corrupt backup");
    const id = `r2-${sha(JSON.stringify(items)).slice(0, 28)}`;
    const path = `/workflows/article-archive-migration/instances/${id}`;
    const response = await fetch(base + path, { headers: { Authorization: `Bearer ${await auth()}` } });
    if (response.status === 404) await json("/workflows/article-archive-migration/instances", "POST", { instance_id: id, params: { items } });
    else if (!response.ok) throw new Error(`Workflow lookup failed: HTTP ${response.status}`);
    batches.push({ id, items: items.length });
    await save("batches.json", batches);
    if (batches.length % 10 === 0) console.log(JSON.stringify({ submitted: batches.length, items: Math.min(index + 25, selected.length) }));
  }
  await save("batches.json", batches);
  console.log(JSON.stringify({ submitted: batches.length, items: selected.length }));
} else {
  const [items, objects] = await Promise.all([listItems(targetPath), listObjects()]);
  const indexed = new Map(items.filter(item => item.source_id === "r2:article").map(item => [item.key, item]));
  const failures = objects.filter(object => {
    const item = indexed.get(object.key);
    return !item || item.status !== "completed" || item.checksum !== object.etag ||
      new Date(String(object.custom_metadata?.published_at)).valueOf() !== Number(item.metadata?.published_at) ||
      ["source", "tags", "importance", "type"].some(field => {
        const expected = object.custom_metadata?.[field];
        return expected !== undefined && expected !== "" && String(item.metadata?.[field]) !== expected;
      });
  }).map(object => ({ key: object.key, status: indexed.get(object.key)?.status ?? "missing", error: indexed.get(object.key)?.error }));
  await save("verification.json", { objects: objects.length, items: items.length, failures });
  console.log(JSON.stringify({ objects: objects.length, items: items.length, failures: failures.length }));
  if (failures.length) throw new Error("R2 indexing is not fully verified");
  if (command === "cleanup") {
    if (!values.apply) throw new Error("cleanup requires --apply");
    const config = z.object({ public_endpoint_params: z.object({ custom_domains: z.array(z.string()) }) }).parse((await json(targetPath)).result);
    if (!config.public_endpoint_params.custom_domains.includes("search.hasbai.xyz")) throw new Error("Target instance does not serve the existing public endpoint");
    const entries = z.array(z.object({ itemId: z.string(), key: z.string(), r2Key: z.string() })).parse(JSON.parse(await readFile(file("manifest.json"), "utf8")));
    const hashes = z.array(z.object({ itemId: z.string(), sha256: z.string() })).parse(JSON.parse(await readFile(file("backup-hashes.json"), "utf8")));
    const legacy = (await listItems(sourcePath)).filter(item => item.source_id === "builtin");
    const selected = values.limit ? legacy.slice(0, Number(values.limit)) : legacy;
    await each(selected, async item => {
      if (item.source_id !== "builtin") throw new Error("Refusing non-builtin deletion");
      const entry = entries.find(entry => entry.itemId === item.id && entry.key === item.key);
      if (!entry || indexed.get(entry.r2Key)?.status !== "completed") throw new Error("No verified R2 counterpart");
      const backup = await readFile(file(`builtin/${item.id}.md`));
      const hash = hashes.find(hash => hash.itemId === item.id)?.sha256;
      if (sha(backup) !== hash || sha(await bodyBytes(await request(`${sourcePath}/items/${item.id}/download`))) !== hash) throw new Error("Source content changed since backup");
      await json(`${sourcePath}/items/${item.id}`, "DELETE");
    });
  }
}
