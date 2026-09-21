import { z } from "zod";
import { prepareAiSearchMarkdown } from "./article";

const cleanupItemSchema = z.object({
  key: z.string().regex(/^report\/\d{4}-\d{2}-\d{2}\/[^/]+\.md$/),
  etag: z.string().regex(/^[a-f0-9]{32}$/),
});

/** Call only with a frozen manifest whose original bodies have been backed up. */
export async function cleanArchivedReport(
  bucket: Pick<R2Bucket, "get" | "put">,
  input: z.infer<typeof cleanupItemSchema>,
) {
  const item = cleanupItemSchema.parse(input);
  const original = await bucket.get(item.key);
  if (!original) throw new Error(`Missing archived report: ${item.key}`);
  if (original.size > 4 * 1024 * 1024) throw new Error("Archived report exceeds 4 MiB");
  const body = await original.text();
  const cleaned = prepareAiSearchMarkdown(body);
  const titleOnly = !cleaned.replace(/^# [^\n]*\n*/, "").trim();
  if (cleaned === body) return { key: item.key, changed: false, etag: original.etag, titleOnly };
  if (original.etag !== item.etag) throw new Error(`Archived report changed after backup: ${item.key}`);
  const stored = await bucket.put(item.key, cleaned, {
    httpMetadata: original.httpMetadata,
    customMetadata: original.customMetadata,
    storageClass: original.storageClass,
    onlyIf: { etagMatches: original.etag, uploadedBefore: new Date(original.uploaded.valueOf() + 1) },
  });
  if (!stored) throw new Error(`Archived report changed during cleanup: ${item.key}`);
  return { key: item.key, changed: true, etag: stored.etag, titleOnly };
}
