import { articleObjectKey, type ArticleMetadata } from "./article";

export const REQUIRED_AI_SEARCH_METADATA_FIELDS = [
  "published_at",
  "source",
  "tags",
  "importance",
] as const;

export type RequiredAiSearchMetadataField =
  (typeof REQUIRED_AI_SEARCH_METADATA_FIELDS)[number];

export interface MetadataRepairItem {
  id: string;
  key: string;
  status: "completed" | "error" | "skipped" | "queued" | "running" | "outdated";
  metadata?: Record<string, unknown>;
}

export interface MetadataRepairTarget {
  item: MetadataRepairItem;
  article: ArticleMetadata;
  missingFields: RequiredAiSearchMetadataField[];
}

export interface MetadataRepairSelection {
  targets: MetadataRepairTarget[];
  unmatched: MetadataRepairItem[];
  ambiguous: Array<{ item: MetadataRepairItem; articleIds: string[] }>;
  inFlight: MetadataRepairItem[];
}

export function missingAiSearchMetadataFields(
  metadata: Record<string, unknown> | undefined,
): RequiredAiSearchMetadataField[] {
  return REQUIRED_AI_SEARCH_METADATA_FIELDS.filter(
    (field) =>
      !metadata
      || !Object.prototype.hasOwnProperty.call(metadata, field)
      || metadata[field] === null
      || metadata[field] === undefined,
  );
}

export function selectMetadataRepairTargets(
  items: MetadataRepairItem[],
  articles: ArticleMetadata[],
): MetadataRepairSelection {
  const articlesByKey = new Map<string, ArticleMetadata[]>();
  for (const article of articles) {
    const key = articleObjectKey(article);
    const matches = articlesByKey.get(key) || [];
    matches.push(article);
    articlesByKey.set(key, matches);
  }

  const selection: MetadataRepairSelection = {
    targets: [],
    unmatched: [],
    ambiguous: [],
    inFlight: [],
  };
  for (const item of items) {
    const missingFields = missingAiSearchMetadataFields(item.metadata);
    if (missingFields.length === 0) continue;
    if (item.status === "queued" || item.status === "running") {
      selection.inFlight.push(item);
      continue;
    }
    const matches = articlesByKey.get(item.key) || [];
    if (matches.length === 0) {
      selection.unmatched.push(item);
    } else if (matches.length > 1) {
      selection.ambiguous.push({ item, articleIds: matches.map((article) => article.id) });
    } else {
      const article = matches[0];
      if (article) selection.targets.push({ item, article, missingFields });
    }
  }

  selection.targets.sort((left, right) => left.item.key.localeCompare(right.item.key));
  selection.unmatched.sort((left, right) => left.key.localeCompare(right.key));
  selection.ambiguous.sort((left, right) => left.item.key.localeCompare(right.item.key));
  selection.inFlight.sort((left, right) => left.key.localeCompare(right.key));
  return selection;
}
