import { readArchiveBody } from "./archive-body";
export { readArchiveBody } from "./archive-body";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { prepareAiSearchMarkdown } from "./article";
import { runResearchMigration, type ResearchMigrationParams } from "./research-migration";

const entrySchema = z.object({
  itemId: z.string().regex(/^[a-f0-9]{32}$/),
  key: z.string().min(1).max(1024),
  r2Key: z.string().min(1).max(1024),
  preferExistingEtag: z.string().regex(/^[a-f0-9]{32}$/).optional(),
}).strict();
const paramsSchema = z.object({ items: z.array(entrySchema).min(1).max(50) }).strict();
export type ArchiveMigrationParams = z.infer<typeof paramsSchema> | ResearchMigrationParams;

// Only existing archive aliases are accepted: Items uploads historically escaped
// quotes in filenames. Never silently change arbitrary object paths.
export function validateArchiveKey(key: string, r2Key: string): void {
  if (r2Key !== key && r2Key !== key.replaceAll("%22", '"')) {
    throw new Error("Unexpected archive key mapping");
  }
  if (!/^\d{4}-\d{2}-\d{2}\/.+\.md$/.test(r2Key)) {
    throw new Error("Expected a dated Markdown article key");
  }
}

export function migrateArchiveMetadata(
  current: Record<string, string>,
  indexed: Record<string, unknown>,
): Record<string, string> {
  const metadata = { ...current };
  for (const field of ["type", "source", "tags", "importance"] as const) {
    const value = indexed[field];
    if (metadata[field] === undefined && (typeof value === "string" || typeof value === "number")) {
      metadata[field] = String(value);
    }
  }
  metadata.source ??= current.author ?? "";
  metadata.tags ??= current.keywords ?? "";
  const publishedAt = current.published_at ?? indexed.published_at;
  if (typeof publishedAt !== "string" && typeof publishedAt !== "number") {
    throw new Error("Missing original published_at; refusing to use migration time");
  }
  const date = new Date(publishedAt);
  if (Number.isNaN(date.valueOf())) throw new Error("Invalid published_at");
  metadata.published_at = date.toISOString();
  const bytes = Object.entries(metadata).reduce(
    (size, [key, value]) => size + new TextEncoder().encode(key + value).byteLength, 0,
  );
  if (bytes > 2048) throw new Error("R2 metadata exceeds 2048 bytes");
  return metadata;
}

export function sameArticleContent(left: string, right: string): boolean {
  return prepareAiSearchMarkdown(left) === prepareAiSearchMarkdown(right);
}

/** Manually triggered maintenance only; never called by Cron or ArticleWorkflow. */
export class ArticleArchiveMigrationWorkflow extends WorkflowEntrypoint<Env, ArchiveMigrationParams> {
  override async run(event: Readonly<WorkflowEvent<ArchiveMigrationParams>>, step: WorkflowStep) {
    if ("migration" in event.payload) return await runResearchMigration(this.env, event.payload, step);
    const params = paramsSchema.parse(event.payload);
    const results = [];
    for (const entry of params.items) {
      validateArchiveKey(entry.key, entry.r2Key);
      const result = await step.do(`archive-${entry.itemId}`, {
        retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      }, async () => {
        const item = this.env.FINANCE_SEARCH.items.get(entry.itemId);
        const info = await item.info();
        if (info.source_id !== "builtin" || info.key !== entry.key) {
          throw new NonRetryableError("Migration item no longer matches the manifest");
        }
        const existing = await this.env.ARTICLE_BUCKET.get(entry.r2Key);
        if (entry.key !== entry.r2Key && !existing) {
          throw new NonRetryableError("Archive alias must already exist");
        }
        const content = await readArchiveBody((await item.download()).body);
        const original = existing ? await readArchiveBody(existing.body) : content;
        if (!sameArticleContent(original, content) &&
          (!existing || entry.preferExistingEtag !== existing.etag)) {
          throw new NonRetryableError(`Conflicting bodies for ${entry.r2Key}`);
        }
        const metadata = migrateArchiveMetadata(existing?.customMetadata ?? {}, info.metadata ?? {});
        // R2 is now the direct indexing source, so the existing CJK sentence
        // boundary workaround must be applied before this sole stored copy.
        const stored = await this.env.ARTICLE_BUCKET.put(entry.r2Key, prepareAiSearchMarkdown(original), {
          httpMetadata: existing?.httpMetadata ?? { contentType: "text/markdown; charset=utf-8" },
          customMetadata: metadata,
          onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: "*" },
        });
        if (!stored) throw new Error("R2 changed concurrently; retry required");
        const verified = await this.env.ARTICLE_BUCKET.head(entry.r2Key);
        if (!verified || verified.etag !== stored.etag ||
          Object.entries(metadata).some(([key, value]) => verified.customMetadata?.[key] !== value)) {
          throw new Error("R2 archive verification failed");
        }
        return { itemId: entry.itemId, key: entry.r2Key, etag: stored.etag, size: stored.size };
      });
      results.push(result);
    }
    return { archived: results.length, items: results };
  }
}
