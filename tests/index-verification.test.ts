import { describe, expect, it } from "vitest";
import { hasCompleteVectorCoverage, indexVerificationIssues } from "../scripts/cloudflare-maintenance";

const object = { key: "report/2026-08-25/研报.md", etag: "r2-body-md5", size: 42,
  last_modified: "2026-09-07T03:21:42.133Z", custom_metadata: { type: "研报", published_at: "2026-08-25T09:04:16.000Z" } };
const item = { id: "item", key: object.key, source_id: "r2:article", status: "completed",
  checksum: "opaque-service-version", last_seen_at: "2026-09-07 03:28:10",
  metadata: { type: "研报", published_at: Date.parse(object.custom_metadata.published_at) } };

describe("R2 indexing acceptance", () => {
  it("keeps source-version identifiers separate from R2 content hashes", () => {
    expect(indexVerificationIssues(item, object)).toEqual([]);
  });
  it("rejects a completed index when the R2 source changed after its last scan", () => {
    expect(indexVerificationIssues({ ...item, last_seen_at: "2026-09-07 03:20:00" }, object)).toContain("source not yet scanned");
  });
  it("rejects wrong document types and publication dates even with a completed status", () => {
    expect(indexVerificationIssues({ ...item, metadata: { type: "政策", published_at: 0 } }, object)).toEqual(["published_at", "type"]);
  });
  it("accepts a stale running state only when every source chunk is served by vector search", () => {
    const pending = { ...item, status: "running", chunks_count: 2 };
    const chunks = ["a", "b"].map(id => ({ id, item: { key: item.key, metadata: item.metadata } }));
    const vectors = chunks.map(chunk => ({ ...chunk, scoring_details: { vector_score: 0.7 } }));
    expect(hasCompleteVectorCoverage(pending, pending, object, chunks, vectors)).toBe(true);
    expect(hasCompleteVectorCoverage(pending, pending, object, chunks, vectors.slice(0, 1))).toBe(false);
    expect(hasCompleteVectorCoverage(pending, pending, object, chunks, chunks)).toBe(false);
    expect(hasCompleteVectorCoverage(pending, { ...pending, checksum: "changed" }, object, chunks, vectors)).toBe(false);
    expect(hasCompleteVectorCoverage({ ...pending, status: "error" }, pending, object, chunks, vectors)).toBe(false);
    expect(hasCompleteVectorCoverage(pending, pending, object, chunks, vectors.map(chunk => ({ ...chunk,
      item: { ...chunk.item, metadata: { ...item.metadata, type: "政策" } } })))).toBe(false);
  });
});
