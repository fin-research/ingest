/** Node 24+: freeze and back up an inventory before submitting resumable Workflows. */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createMaintenanceClient, HttpError, objectSchema, bodyBytes, indexVerificationIssues } from "./cloudflare-maintenance.ts";
import { POLICY_ARCHIVE_QUERY, policyArchiveDocument, storedPolicySchema } from "../src/policy-archive.ts";
import { prepareAiSearchMarkdown } from "../src/article.ts";
import type { ResearchMigrationParams } from "../src/research-migration.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  directory: { type: "string", default: "var/research-migration" },
  credentials: { type: "string", default: `${homedir()}/Library/Preferences/.wrangler/config/default.toml` },
  apply: { type: "boolean", default: false }, limit: { type: "string" },
} });
const command = positionals[0];
if (!["inventory", "backup", "copy", "status", "verify", "verify-index", "cleanup"].includes(command ?? "")) {
  throw new Error("Usage: node scripts/migrate-research.ts inventory|backup|copy|status|verify|verify-index|cleanup [--apply] [--limit N]");
}
const directory = resolve(values.directory);
await mkdir(directory, { recursive: true, mode: 0o700 });
const file = (name: string) => resolve(directory, name);
const hash = (input: string | Uint8Array, algorithm = "sha256") => createHash(algorithm).update(input).digest("hex");
const { request, json, listItems, listObjects } = createMaintenanceClient(values.credentials);
const targetPath = "/ai-search/namespaces/default/instances/research";
const inventorySchema = z.object({ reports: z.array(objectSchema), policies: z.array(storedPolicySchema) });
type Inventory = z.infer<typeof inventorySchema>;
async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
async function save(name: string, value: unknown) { await writeFile(file(name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); }
async function inventory(): Promise<Inventory> { return inventorySchema.parse(JSON.parse(await readFile(file("inventory.json"), "utf8"))); }
async function each<T>(entries: T[], operation: (entry: T) => Promise<void>) {
  let index = 0, complete = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (index < entries.length) {
      await operation(entries[index++]!);
      if (++complete % 100 === 0 || complete === entries.length) console.log(JSON.stringify({ command, complete, total: entries.length }));
    }
  }));
}

if (command === "inventory") {
  if (await exists(file("inventory.json"))) throw new Error("Inventory already frozen; use a new directory for a delta");
  const objects = await listObjects();
  const response = await json("/d1/database/b80cfbe1-1226-46cc-a22b-3ebbaefe85bf/query", "POST", { sql: POLICY_ARCHIVE_QUERY });
  const policies = z.array(z.object({ results: z.array(storedPolicySchema) })).parse(response.result).flatMap(value => value.results);
  const reports = objects.filter(value => /^\d{4}-\d{2}-\d{2}\/.+\.md$/.test(value.key));
  const keys = [...reports.map(value => `report/${value.key}`), ...policies.map(value => policyArchiveDocument(value).key)];
  if (new Set(keys).size !== keys.length) throw new Error("Conflicting destination keys in inventory");
  await save("inventory.json", { reports, policies });
  console.log(JSON.stringify({ reports: reports.length, policies: policies.length }));
} else if (command === "backup") {
  const data = await inventory();
  await mkdir(file("report-original"), { recursive: true, mode: 0o700 });
  await each(data.reports, async object => {
    const path = file(`report-original/${hash(object.key)}.md`);
    let content: Buffer;
    if (await exists(path)) content = await readFile(path);
    else {
      try {
        content = await bodyBytes(await request("/r2/buckets/article/objects/" + object.key.split("/").map(encodeURIComponent).join("/")));
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        // Legacy '?' keys are inaccessible through R2's management GET.
        // The earlier migration's exact backup can reconstruct the current copy,
        // but it is accepted only if its MD5 matches this frozen R2 ETag.
        let original: string;
        const oldR2 = resolve("var/ai-search-r2/r2-original", `${hash(object.key)}.md`);
        if (await exists(oldR2)) original = await readFile(oldR2, "utf8");
        else {
          const manifest = z.array(z.object({ itemId: z.string(), r2Key: z.string() })).parse(JSON.parse(await readFile("var/ai-search-r2/manifest.json", "utf8")));
          const entry = manifest.find(entry => entry.r2Key === object.key);
          if (!entry) throw new Error(`No exact previous backup for ${object.key}`);
          original = await readFile(resolve("var/ai-search-r2/builtin", `${entry.itemId}.md`), "utf8");
        }
        content = Buffer.from(prepareAiSearchMarkdown(original));
      }
    }
    if (hash(content, "md5") !== object.etag) throw new Error(`Backup checksum mismatch: ${object.key}`);
    await writeFile(path, content, { mode: 0o600 });
  });
  await save("backup-complete.json", { inventoryHash: hash(await readFile(file("inventory.json"))), reports: data.reports.length, policies: data.policies.length });
} else if (command === "copy" || command === "cleanup") {
  const data = await inventory();
  const backup = z.object({ inventoryHash: z.string() }).parse(JSON.parse(await readFile(file("backup-complete.json"), "utf8")));
  if (backup.inventoryHash !== hash(await readFile(file("inventory.json")))) throw new Error("Backup inventory changed");
  if (command === "cleanup") {
    await verify(true);
    const config = z.object({ public_endpoint_params: z.object({ custom_domains: z.array(z.string()) }) }).parse((await json(targetPath)).result);
    if (!config.public_endpoint_params.custom_domains.includes("search.hasbai.xyz")) throw new Error("Public domain has not moved to research");
  }
  const entries: Array<{ report: Inventory["reports"][number] } | { policy: Inventory["policies"][number] }> = [
    ...data.reports.map(report => ({ report })), ...(command === "copy" ? data.policies.map(policy => ({ policy })) : []),
  ];
  const limit = values.limit === undefined ? entries.length : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid limit");
  const batches = [];
  for (let offset = 0; offset < Math.min(entries.length, limit); offset += 25) {
    const batch = entries.slice(offset, Math.min(offset + 25, limit));
    const params: ResearchMigrationParams = {
      migration: "research", action: command,
      reports: batch.flatMap(entry => "report" in entry ? [{ key: entry.report.key, etag: entry.report.etag, metadata: entry.report.custom_metadata ?? {} }] : []),
      policies: batch.flatMap(entry => "policy" in entry ? [{ sentimentId: entry.policy.sentiment_id, snapshotHash: hash(JSON.stringify(policyArchiveDocument(entry.policy))) }] : []),
    };
    for (const entry of params.reports) {
      const backup = await readFile(file(`report-original/${hash(entry.key)}.md`));
      if (hash(backup, "md5") !== entry.etag) throw new Error("Report backup changed");
      entry.targetEtag = hash(prepareAiSearchMarkdown(backup.toString("utf8")), "md5");
    }
    const id = `research-${hash(JSON.stringify(params)).slice(0,28)}`;
    if (values.apply) {
      try { await json(`/workflows/article-archive-migration/instances/${id}`); }
      catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        await json("/workflows/article-archive-migration/instances", "POST", { instance_id: id, params });
      }
    }
    batches.push({ id, count: batch.length });
    await save(`${command}-batches.json`, batches);
    console.log(JSON.stringify({ command, applied: values.apply, batch: batches.length, count: batch.length, id }));
  }
} else if (command === "status") {
  const batches = z.array(z.object({ id: z.string() })).parse(JSON.parse(await readFile(file("copy-batches.json"), "utf8")));
  const statuses: Record<string, number> = {};
  await each(batches, async ({ id }) => {
    const value = z.object({ status: z.string() }).passthrough().parse((await json(`/workflows/article-archive-migration/instances/${id}`)).result);
    statuses[value.status] = (statuses[value.status] ?? 0) + 1;
    if (value.status === "errored") await save(`${id}-error.json`, value);
  });
  console.log(JSON.stringify(statuses));
} else await verify(command === "verify-index");

async function verify(index: boolean) {
  const data = await inventory();
  const objects = await listObjects();
  const byKey = new Map(objects.map(value => [value.key, value]));
  const failures: string[] = [];
  const expected = [
    ...await Promise.all(data.reports.map(async value => ({
      key: `report/${value.key}`,
      etag: hash(prepareAiSearchMarkdown(await readFile(file(`report-original/${hash(value.key)}.md`), "utf8")), "md5"),
      metadata: { ...value.custom_metadata, type: "研报" },
    }))),
    ...data.policies.map(value => { const doc = policyArchiveDocument(value); return { key: doc.key, etag: hash(doc.content, "md5"), metadata: doc.metadata }; }),
  ];
  for (const item of expected) {
    const actual = byKey.get(item.key);
    if (!actual || actual.etag !== item.etag || Object.entries(item.metadata).some(([key, value]) => actual.custom_metadata?.[key] !== value)) failures.push(`archive: ${item.key}`);
  }
  if (index) {
    const items = await listItems(targetPath);
    const indexed = new Map(items.filter(value => value.source_id === "r2:article").map(value => [value.key, value]));
    for (const object of objects.filter(value => /^(report|policy)\//.test(value.key))) {
      const item = indexed.get(object.key);
      const issues = indexVerificationIssues(item, object);
      if (issues.length) failures.push(`index: ${object.key} (${issues.join(", ")})`);
    }
    await save("indexed-items.json", items);
  }
  await save(index ? "index-verification.json" : "archive-verification.json", { checkedAt: new Date().toISOString(), reports: data.reports.length, policies: data.policies.length, failures });
  console.log(JSON.stringify({ reports: data.reports.length, policies: data.policies.length, failures: failures.length }));
  if (failures.length) throw new Error(`Verification failed; see ${index ? "index" : "archive"}-verification.json`);
}
