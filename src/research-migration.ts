import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { readArchiveBody } from "./archive-body";
import { POLICY_ARCHIVE_QUERY, policyArchiveDocument, storedPolicySchema } from "./policy-archive";

export const researchMigrationSchema = z.object({
  migration: z.literal("research"), action: z.enum(["copy", "cleanup"]),
  reports: z.array(z.object({
    key: z.string().regex(/^\d{4}-\d{2}-\d{2}\/.+\.md$/),
    etag: z.string(), metadata: z.record(z.string(), z.string()),
  }).strict()).max(25).default([]),
  policies: z.array(z.object({
    sentimentId: z.string().regex(/^[A-Za-z0-9_-]+$/), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(25).default([]),
}).strict().refine(value => value.reports.length + value.policies.length > 0 &&
  value.reports.length + value.policies.length <= 25 &&
  (value.action !== "cleanup" || value.policies.length === 0), "Invalid migration batch");
export type ResearchMigrationParams = z.infer<typeof researchMigrationSchema>;
const researchIndexRetrySchema = z.object({
  migration: z.literal("research-index-retry"),
  itemIds: z.array(z.string().regex(/^[a-f0-9]{32}$/)).min(1).max(10),
}).strict();
export type ResearchIndexRetryParams = z.infer<typeof researchIndexRetrySchema>;

export async function retryResearchIndex(env: Env, payload: ResearchIndexRetryParams, step: WorkflowStep) {
  const params = researchIndexRetrySchema.parse(payload);
  const items = [];
  for (const id of params.itemIds) {
    items.push(await step.do(`retry-index-${id}`, async () => {
      const item = env.RESEARCH_SEARCH.items.get(id);
      const info = await item.info();
      if (info.source_id !== "r2:article" || !/^(report|policy)\//.test(info.key)) {
        throw new NonRetryableError("Refusing to retry an unrelated source");
      }
      if (info.status !== "error") return { id, status: info.status, requested: false };
      const result = await item.sync();
      return { id, status: result.status, requested: true };
    }));
  }
  return { items };
}

export async function documentHash(document: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(document)));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function metadataEqual(left: Record<string, string>, right: Record<string, string>) {
  return Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([key, value]) => right[key] === value);
}

async function verifyArchive(bucket: R2Bucket, key: string, content: string, metadata: Record<string, string>) {
  const object = await bucket.get(key);
  if (!object || !metadataEqual(object.customMetadata ?? {}, metadata) ||
    await readArchiveBody(object.body) !== content) {
    throw new NonRetryableError(`Destination verification failed: ${key}`);
  }
  return { key, etag: object.etag, size: object.size };
}

async function copyArchive(bucket: R2Bucket, key: string, content: string, metadata: Record<string, string>) {
  const existing = await bucket.get(key);
  if (existing && await readArchiveBody(existing.body) !== content) {
    throw new NonRetryableError(`Conflicting destination: ${key}`);
  }
  const result = await bucket.put(key, content, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" }, customMetadata: metadata,
    onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: "*" },
  });
  if (!result) throw new Error("Destination changed concurrently");
  return await verifyArchive(bucket, key, content, metadata);
}

export async function runResearchMigration(env: Env, payload: ResearchMigrationParams, step: WorkflowStep) {
  const params = researchMigrationSchema.parse(payload);
  const results = [];
  for (const [index, entry] of params.reports.entries()) {
    results.push(await step.do(`research-report-${index}`, async () => {
      const source = await env.ARTICLE_BUCKET.get(entry.key);
      const key = `report/${entry.key}`;
      const metadata = { ...entry.metadata, type: "研报" };
      if (!source) {
        if (params.action !== "cleanup") throw new NonRetryableError("Report source is missing");
        const target = await env.ARTICLE_BUCKET.head(key);
        if (!target || target.etag !== entry.etag || !metadataEqual(target.customMetadata ?? {}, metadata)) {
          throw new NonRetryableError("Missing verified destination for deleted source");
        }
        return { key, etag: target.etag, deleted: entry.key };
      }
      if (source.etag !== entry.etag || !metadataEqual(source.customMetadata ?? {}, entry.metadata)) {
        throw new NonRetryableError("Report source changed since inventory");
      }
      const content = await readArchiveBody(source.body);
      const verified = params.action === "copy"
        ? await copyArchive(env.ARTICLE_BUCKET, key, content, metadata)
        : await verifyArchive(env.ARTICLE_BUCKET, key, content, metadata);
      if (params.action === "cleanup") {
        await env.ARTICLE_BUCKET.delete(entry.key);
        if (await env.ARTICLE_BUCKET.head(entry.key)) throw new Error("Source removal failed");
      }
      return { ...verified, ...(params.action === "cleanup" ? { deleted: entry.key } : {}) };
    }));
  }
  for (const entry of params.policies) {
    results.push(await step.do(`research-policy-${entry.sentimentId}`, async () => {
      const row = storedPolicySchema.parse(await env.DB.prepare(
        `${POLICY_ARCHIVE_QUERY} WHERE pn.sentiment_id = ?`,
      ).bind(entry.sentimentId).first());
      const document = policyArchiveDocument(row);
      if (await documentHash(document) !== entry.snapshotHash) {
        throw new NonRetryableError("Policy changed since the backed-up inventory");
      }
      return await copyArchive(env.ARTICLE_BUCKET, document.key, document.content, document.metadata);
    }));
  }
  return { action: params.action, processed: results.length, items: results };
}
