import { describe, expect, it } from "vitest";

import type { ArticleMetadata } from "../src/article";
import {
  missingAiSearchMetadataFields,
  selectMetadataRepairTargets,
  type MetadataRepairItem,
} from "../src/metadata-repair";

const article: ArticleMetadata = {
  id: "article-1",
  title: "测试/研报",
  publishedAt: "2026-08-19T16:00:00Z",
};

function item(overrides: Partial<MetadataRepairItem> = {}): MetadataRepairItem {
  return {
    id: "item-1",
    key: "2026-08-20/测试_研报.md",
    status: "completed",
    metadata: {
      published_at: "2026-08-19T16:00:00.000Z",
      source: "测试机构",
      tags: "政策",
      importance: "70",
    },
    ...overrides,
  };
}

describe("AI Search metadata repair selection", () => {
  it("treats field presence as complete, including empty source and zero importance", () => {
    expect(missingAiSearchMetadataFields({
      published_at: "2026-08-19T16:00:00.000Z",
      source: "",
      tags: "政策",
      importance: 0,
    })).toEqual([]);
    expect(missingAiSearchMetadataFields({
      published_at: null,
      source: "机构",
      tags: "政策",
      importance: undefined,
    })).toEqual(["published_at", "importance"]);
  });

  it("selects exact D1 object-key matches and reports every missing field", () => {
    const incomplete = item({ metadata: { source: "测试机构" } });
    const selection = selectMetadataRepairTargets([incomplete], [article]);

    expect(selection.targets).toHaveLength(1);
    expect(selection.targets[0]).toMatchObject({
      article: { id: "article-1" },
      missingFields: ["published_at", "tags", "importance"],
    });
    expect(selection.unmatched).toEqual([]);
  });

  it("does not race in-flight items and does not guess unmatched or ambiguous mappings", () => {
    const duplicate = { ...article, id: "article-2" };
    const selection = selectMetadataRepairTargets(
      [
        item({ id: "running", status: "running", metadata: {} }),
        item({ id: "ambiguous", metadata: {} }),
        item({ id: "unmatched", key: "2026-08-20/不存在.md", metadata: {} }),
      ],
      [article, duplicate],
    );

    expect(selection.targets).toEqual([]);
    expect(selection.inFlight.map((entry) => entry.id)).toEqual(["running"]);
    expect(selection.ambiguous[0]?.articleIds).toEqual(["article-1", "article-2"]);
    expect(selection.unmatched.map((entry) => entry.id)).toEqual(["unmatched"]);
  });
});
