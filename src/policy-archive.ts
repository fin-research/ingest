import { z } from "zod";
import { articleObjectKey, buildArticleMarkdown, prepareAiSearchMarkdown, validateArticleMetadata } from "./article.ts";
import type { PolicyAggregationResult, PolicyNewsEvidence } from "./policy";

const storedPolicySchema = z.object({
  sentiment_id: z.string(), title: z.string(), published_at: z.string(),
  content: z.string().min(1), departments_json: z.string().nullable(),
});
type StoredPolicy = z.infer<typeof storedPolicySchema>;

export function policyArchiveDocument(value: StoredPolicy) {
  const row = storedPolicySchema.parse(value);
  const article = validateArticleMetadata({ id: row.sentiment_id, title: row.title, time: row.published_at });
  const departments = z.array(z.string()).parse(JSON.parse(row.departments_json ?? "[]"));
  return {
    key: articleObjectKey(article, "policy"),
    content: prepareAiSearchMarkdown(buildArticleMarkdown(article, { content: row.content })),
    metadata: {
      type: "政策", source: departments.join(","), tags: "中央政策",
      published_at: new Date(row.published_at).toISOString(),
    },
  };
}

export async function archivePolicyEvidence(
  bucket: R2Bucket, evidence: PolicyNewsEvidence[], aggregation: PolicyAggregationResult,
) {
  const archived = [];
  for (const row of evidence) {
    const group = aggregation.groups.find(group => group.newsIds.includes(row.id));
    if (!group) throw new Error("Policy archive is missing its aggregation group");
    const document = policyArchiveDocument({
      sentiment_id: row.id, title: row.title, published_at: row.publishedAt,
      content: row.content, departments_json: JSON.stringify(group.departments),
    });
    const stored = await bucket.put(document.key, document.content, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" }, customMetadata: document.metadata,
    });
    if (!stored) throw new Error("Policy archive write failed");
    archived.push({ key: document.key, etag: stored.etag });
  }
  return { archived: archived.length, items: archived };
}
