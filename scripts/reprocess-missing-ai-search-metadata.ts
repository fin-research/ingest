import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { unstable_readConfig } from "wrangler";

import {
  ARTICLE_METADATA_REPAIR_MODE,
  readTextBounded,
  validateArticleMetadata,
  type ArticleMetadata,
} from "../src/article";
import {
  missingAiSearchMetadataFields,
  selectMetadataRepairTargets,
  type MetadataRepairItem,
  type MetadataRepairTarget,
} from "../src/metadata-repair";

const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const AI_SEARCH_PAGE_SIZE = 50;
const TERMINAL_WORKFLOW_STATUSES = new Set(["complete", "errored", "terminated"]);

interface ScriptOptions {
  configPath: string;
  execute: boolean;
  limit?: number;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
}

interface RuntimeConfig {
  accountId: string;
  databaseId: string;
  aiSearchInstance: string;
  workflowName: string;
}

interface WorkflowRunResult {
  target: MetadataRepairTarget;
  instanceId: string;
  status: string;
  error?: string;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const token = requiredEnvironmentVariable("CLOUDFLARE_API_TOKEN");
  const runtime = loadRuntimeConfig(options.configPath);
  const client = new CloudflareMaintenanceClient(runtime, token);

  const [items, articles] = await Promise.all([
    client.listAiSearchItems(),
    client.listD1Articles(),
  ]);
  const selection = selectMetadataRepairTargets(items, articles);
  const selectedTargets = options.limit === undefined
    ? selection.targets
    : selection.targets.slice(0, options.limit);
  const deferredTargets = selection.targets.length - selectedTargets.length;

  for (const target of selection.targets) {
    console.log(JSON.stringify({
      event: "metadata_repair_candidate",
      key: target.item.key,
      articleId: target.article.id,
      status: target.item.status,
      missingFields: target.missingFields,
      selected: selectedTargets.includes(target),
    }));
  }
  for (const item of selection.unmatched) {
    console.warn(JSON.stringify({ event: "metadata_repair_unmatched", key: item.key, itemId: item.id }));
  }
  for (const item of selection.inFlight) {
    console.warn(JSON.stringify({
      event: "metadata_repair_in_flight",
      key: item.key,
      itemId: item.id,
      status: item.status,
    }));
  }
  for (const ambiguous of selection.ambiguous) {
    console.warn(JSON.stringify({
      event: "metadata_repair_ambiguous",
      key: ambiguous.item.key,
      itemId: ambiguous.item.id,
      articleIds: ambiguous.articleIds,
    }));
  }

  console.log(JSON.stringify({
    event: "metadata_repair_inventory",
    execute: options.execute,
    aiSearchItems: items.length,
    d1Articles: articles.length,
    candidates: selection.targets.length,
    selected: selectedTargets.length,
    deferred: deferredTargets,
    unmatched: selection.unmatched.length,
    ambiguous: selection.ambiguous.length,
    inFlight: selection.inFlight.length,
  }));

  if (!options.execute || selectedTargets.length === 0) {
    if (!options.execute) {
      console.log(JSON.stringify({
        event: "metadata_repair_dry_run_complete",
        next: "rerun with --execute after reviewing the inventory",
      }));
    }
    if (
      options.execute
      && (
        selection.unmatched.length > 0
        || selection.ambiguous.length > 0
        || selection.inFlight.length > 0
      )
    ) {
      process.exitCode = 1;
    }
    return;
  }

  const runId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
  const results = await mapWithConcurrency(
    selectedTargets,
    options.concurrency,
    async (target) => {
      const instanceId = repairInstanceId(runId, target);
      try {
        await client.createArticleWorkflow(instanceId, target.article);
        console.log(JSON.stringify({
          event: "metadata_repair_workflow_started",
          key: target.item.key,
          articleId: target.article.id,
          instanceId,
        }));
        const status = await client.waitForWorkflow(instanceId, options);
        const result: WorkflowRunResult = {
          target,
          instanceId,
          status: status.status,
          ...(status.error ? { error: status.error } : {}),
        };
        console.log(JSON.stringify({
          event: "metadata_repair_workflow_finished",
          key: target.item.key,
          articleId: target.article.id,
          instanceId,
          status: result.status,
          ...(result.error ? { error: result.error } : {}),
        }));
        return result;
      } catch (error) {
        const message = errorMessage(error);
        console.error(JSON.stringify({
          event: "metadata_repair_workflow_failed",
          key: target.item.key,
          articleId: target.article.id,
          instanceId,
          error: message,
        }));
        return { target, instanceId, status: "script_error", error: message };
      }
    },
  );

  const refreshedItems = await client.listAiSearchItems();
  const refreshedByKey = new Map(refreshedItems.map((item) => [item.key, item]));
  const stillMissing = selectedTargets.flatMap((target) => {
    const refreshed = refreshedByKey.get(target.item.key);
    const missingFields = missingAiSearchMetadataFields(refreshed?.metadata);
    return refreshed && missingFields.length === 0
      ? []
      : [{ key: target.item.key, missingFields, itemMissing: !refreshed }];
  });
  const failedWorkflows = results.filter((result) => result.status !== "complete");

  console.log(JSON.stringify({
    event: "metadata_repair_complete",
    attempted: selectedTargets.length,
    completedWorkflows: results.length - failedWorkflows.length,
    failedWorkflows: failedWorkflows.length,
    verifiedMetadataComplete: selectedTargets.length - stillMissing.length,
    stillMissing,
    deferred: deferredTargets,
    unmatched: selection.unmatched.length,
    ambiguous: selection.ambiguous.length,
    inFlight: selection.inFlight.length,
  }));

  if (
    failedWorkflows.length > 0
    || stillMissing.length > 0
    || selection.unmatched.length > 0
    || selection.ambiguous.length > 0
    || selection.inFlight.length > 0
  ) {
    process.exitCode = 1;
  }
}

class CloudflareMaintenanceClient {
  constructor(
    private readonly runtime: RuntimeConfig,
    private readonly token: string,
  ) {}

  async listAiSearchItems(): Promise<MetadataRepairItem[]> {
    const items: MetadataRepairItem[] = [];
    for (let page = 1; ; page++) {
      const url = this.apiUrl(
        `accounts/${this.runtime.accountId}/ai-search/instances/${encodeURIComponent(this.runtime.aiSearchInstance)}/items`,
      );
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", String(AI_SEARCH_PAGE_SIZE));
      url.searchParams.set("source", "builtin");
      const envelope = await this.request(url, {}, `AI Search items page ${page}`);
      if (!Array.isArray(envelope.result)) throw new Error("AI Search items result must be an array");
      const pageItems = envelope.result.map(parseAiSearchItem);
      items.push(...pageItems);

      const info = objectOrUndefined(envelope.result_info);
      const totalCount = optionalNonNegativeInteger(info?.total_count);
      if (
        pageItems.length < AI_SEARCH_PAGE_SIZE
        || (totalCount !== undefined && items.length >= totalCount)
      ) {
        break;
      }
    }
    return items;
  }

  async listD1Articles(): Promise<ArticleMetadata[]> {
    const url = this.apiUrl(
      `accounts/${this.runtime.accountId}/d1/database/${this.runtime.databaseId}/query`,
    );
    const envelope = await this.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: "SELECT id, news_id, title, published_at FROM article ORDER BY published_at, id",
        }),
      },
      "D1 article inventory",
    );
    if (!Array.isArray(envelope.result) || envelope.result.length !== 1) {
      throw new Error("D1 query result must contain exactly one statement result");
    }
    const statement = objectValue(envelope.result[0], "D1 statement result");
    if (statement.success !== true || !Array.isArray(statement.results)) {
      throw new Error("D1 article query did not return rows");
    }
    return statement.results.map((value) => {
      const row = objectValue(value, "D1 article row");
      return validateArticleMetadata({
        id: row.id,
        newsId: row.news_id,
        title: row.title,
        time: row.published_at,
      });
    });
  }

  async createArticleWorkflow(instanceId: string, article: ArticleMetadata): Promise<void> {
    const url = this.apiUrl(
      `accounts/${this.runtime.accountId}/workflows/${encodeURIComponent(this.runtime.workflowName)}/instances`,
    );
    const envelope = await this.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instance_id: instanceId,
          params: JSON.stringify({ ...article, repairMode: ARTICLE_METADATA_REPAIR_MODE }),
        }),
      },
      `create workflow ${instanceId}`,
    );
    const result = objectValue(envelope.result, "workflow create result");
    if (result.id !== instanceId) throw new Error(`workflow returned an unexpected id for ${instanceId}`);
  }

  async waitForWorkflow(
    instanceId: string,
    options: Pick<ScriptOptions, "pollIntervalMs" | "timeoutMs">,
  ): Promise<{ status: string; error?: string }> {
    const deadline = Date.now() + options.timeoutMs;
    while (true) {
      const url = this.apiUrl(
        `accounts/${this.runtime.accountId}/workflows/${encodeURIComponent(this.runtime.workflowName)}/instances/${encodeURIComponent(instanceId)}`,
      );
      url.searchParams.set("simple", "true");
      const envelope = await this.request(url, {}, `workflow status ${instanceId}`);
      const result = objectValue(envelope.result, "workflow status result");
      const status = requiredString(result.status, "workflow status");
      if (TERMINAL_WORKFLOW_STATUSES.has(status)) {
        const workflowError = objectOrUndefined(result.error);
        const error = typeof workflowError?.message === "string" ? workflowError.message : undefined;
        return { status, ...(error ? { error } : {}) };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`workflow ${instanceId} did not finish before timeout`);
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(options.pollIntervalMs, remaining)));
    }
  }

  private apiUrl(path: string): URL {
    return new URL(`${CLOUDFLARE_API_BASE_URL}/${path}`);
  }

  private async request(
    url: URL,
    init: RequestInit,
    label: string,
  ): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Accept", "application/json");
    const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
    const text = await readTextBounded(response, 8 * 1024 * 1024, label);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
    }
    const envelope = objectValue(payload, `${label} response`);
    if (!response.ok || envelope.success !== true) {
      const errors = Array.isArray(envelope.errors)
        ? envelope.errors.map(parseApiError).filter(Boolean).join("; ")
        : "unknown Cloudflare API error";
      throw new Error(`${label} failed with HTTP ${response.status}: ${errors}`);
    }
    return envelope;
  }
}

function loadRuntimeConfig(configPath: string): RuntimeConfig {
  const config = unstable_readConfig(
    { config: resolve(configPath) },
    { hideWarnings: true },
  );
  const configRecord = objectValue(config, "Wrangler config");
  const vars = objectOrUndefined(configRecord.vars);
  const database = objectArray(configRecord.d1_databases, "d1_databases")
    .find((entry) => entry.binding === "DB");
  const aiSearch = objectArray(configRecord.ai_search, "ai_search")
    .find((entry) => entry.binding === "FINANCE_SEARCH");
  const workflow = objectArray(configRecord.workflows, "workflows")
    .find((entry) => entry.binding === "ARTICLE_WORKFLOW");
  return {
    accountId: environmentVariable("CLOUDFLARE_ACCOUNT_ID")
      || requiredString(vars?.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID config var"),
    databaseId: environmentVariable("D1_DATABASE_ID")
      || requiredString(database?.database_id, "DB database_id"),
    aiSearchInstance: environmentVariable("AI_SEARCH_INSTANCE")
      || requiredString(aiSearch?.instance_name, "FINANCE_SEARCH instance_name"),
    workflowName: environmentVariable("ARTICLE_WORKFLOW_NAME")
      || requiredString(workflow?.name, "ARTICLE_WORKFLOW name"),
  };
}

function parseArguments(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    configPath: "wrangler.jsonc",
    execute: false,
    concurrency: 4,
    pollIntervalMs: 5_000,
    timeoutMs: 60 * 60 * 1000,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--execute") {
      options.execute = true;
    } else if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exit(0);
    } else if (argument === "--config") {
      options.configPath = requiredArgument(argv[++index], "--config");
    } else if (argument === "--limit") {
      options.limit = positiveInteger(requiredArgument(argv[++index], "--limit"), "--limit");
    } else if (argument === "--concurrency") {
      options.concurrency = positiveInteger(
        requiredArgument(argv[++index], "--concurrency"),
        "--concurrency",
      );
    } else if (argument === "--poll-interval-ms") {
      options.pollIntervalMs = positiveInteger(
        requiredArgument(argv[++index], "--poll-interval-ms"),
        "--poll-interval-ms",
      );
    } else if (argument === "--timeout-minutes") {
      options.timeoutMs = positiveInteger(
        requiredArgument(argv[++index], "--timeout-minutes"),
        "--timeout-minutes",
      ) * 60_000;
    } else {
      throw new Error(`unsupported argument: ${argument}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: pnpm maintenance:repair-metadata -- [options]

Inventory production AI Search items missing published_at, source, tags, or importance,
map them to D1 articles, and rerun the existing article Workflow in metadata-repair mode.
The default is read-only. Pass --execute to trigger workflows and verify final metadata.

Options:
  --execute                 Trigger and wait for repair workflows
  --limit <count>           Process only the first count candidates
  --concurrency <count>     Maximum active workflows (default: 4)
  --poll-interval-ms <ms>   Workflow status poll interval (default: 5000)
  --timeout-minutes <min>   Per-workflow timeout (default: 60)
  --config <path>           Wrangler config path (default: wrangler.jsonc)
  -h, --help                Show this help

Required environment:
  CLOUDFLARE_API_TOKEN      Token with AI Search Edit/Run, D1 Read, and Workers Scripts Write
`);
}

function parseAiSearchItem(value: unknown): MetadataRepairItem {
  const row = objectValue(value, "AI Search item");
  const status = requiredString(row.status, "AI Search item status");
  if (!isAiSearchStatus(status)) throw new Error(`unsupported AI Search item status: ${status}`);
  const metadata = objectOrUndefined(row.metadata);
  return {
    id: requiredString(row.id, "AI Search item id"),
    key: requiredString(row.key, "AI Search item key"),
    status,
    ...(metadata ? { metadata } : {}),
  };
}

function isAiSearchStatus(value: string): value is MetadataRepairItem["status"] {
  return ["completed", "error", "skipped", "queued", "running", "outdated"].includes(value);
}

function repairInstanceId(runId: string, target: MetadataRepairTarget): string {
  const digest = createHash("sha256")
    .update(`${target.article.id}\0${target.item.id}\0${target.item.key}`)
    .digest("hex")
    .slice(0, 20);
  return `article-repair-${runId}-${digest}`;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: Array<R | undefined> = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  }));
  return results.map((result, index) => {
    if (result === undefined) throw new Error(`missing operation result at index ${index}`);
    return result;
  });
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function objectArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry) => objectValue(entry, `${label} entry`));
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function requiredArgument(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function requiredEnvironmentVariable(name: string): string {
  const value = environmentVariable(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function environmentVariable(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function parseApiError(value: unknown): string {
  const error = objectOrUndefined(value);
  if (!error) return "";
  return [error.code, error.message].filter((part) => part !== undefined).join(": ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "metadata_repair_fatal", error: errorMessage(error) }));
  process.exitCode = 1;
});
