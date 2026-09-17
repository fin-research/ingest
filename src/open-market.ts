import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { fetchOpenMarketNews, fetchResearchReportDetail, type Fetcher } from "./article";
import { dataFetcher } from "./data-fetcher";

const INTERVAL_MS = 10_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface OpenMarketParams { date: string }
export interface OpenMarketResult {
  date: string;
  status: "found" | "not_found" | "failed";
  attempts: number;
  errors: number;
  text: string;
  articleId?: string;
}

interface PollDependencies {
  apiBaseUrl: string;
  fetcher: Fetcher;
  now?: () => number;
}

export async function startOpenMarketWorkflow(
  env: Pick<Env, "OMO_WORKFLOW">,
  scheduledTime: number,
): Promise<void> {
  const shanghai = new Date(scheduledTime + SHANGHAI_OFFSET_MS);
  const weekday = shanghai.getUTCDay();
  if (weekday === 0 || weekday === 6 || shanghai.getUTCHours() !== 9 || shanghai.getUTCMinutes() !== 20) return;
  const date = shanghai.toISOString().slice(0, 10);
  // A daily ID prevents duplicate Cron deliveries from creating another poller.
  const id = `omo-${date}`;
  const [creation] = await Promise.allSettled([env.OMO_WORKFLOW.createBatch([{ id, params: { date } }])]);
  if (creation.status === "fulfilled") return;
  // Also resolves an ambiguous create response after the instance was persisted.
  const existing = await env.OMO_WORKFLOW.get(id);
  await existing.status();
}

export function cleanOpenMarketContent(content: string): string {
  return content
    .replace(/(?:其中[，,]?\s*)?(?:投标量|中标量)\s*(?:为|是|[:：])?\s*[\d,，]+(?:\.\d+)?\s*(?:万亿|亿|万)?元\s*[，,；;]?\s*/g, "")
    .replace(/DM\s*数据显示[，,:：]?\s*/gi, "")
    .replace(/[，,；;]+([。！？])/g, "$1")
    .replace(/^[，,；;。\s]+/g, "")
    .trim();
}

export async function findOpenMarketBulletin(date: string, dependencies: PollDependencies, signal: AbortSignal) {
  const fetcher: Fetcher = async (input, init) => {
    signal.throwIfAborted();
    return await dependencies.fetcher(input, { ...init, signal });
  };
  const articles = await fetchOpenMarketNews(dependencies.apiBaseUrl, date, fetcher);
  let detailErrors = 0;
  for (const article of articles) {
    const [result] = await Promise.allSettled([fetchResearchReportDetail(dependencies.apiBaseUrl, article, fetcher)]);
    if (result.status === "rejected") {
      signal.throwIfAborted();
      detailErrors += 1;
      continue;
    }
    const detail = result.value;
    if (!/净投放|净回笼/.test(detail.content)) continue;
    const text = cleanOpenMarketContent(detail.content);
    if (!text || text.length > 4096) { detailErrors += 1; continue; }
    return { articleId: article.id, text };
  }
  if (detailErrors > 0) throw new Error("Open market bulletin details unavailable");
  return null;
}

/** One query per durable checkpoint; orchestration and waiting stay outside step.do. */
export async function runOmo(date: string, step: Pick<WorkflowStep, "do" | "sleepUntil">, dependencies: PollDependencies): Promise<OpenMarketResult> {
  const now = dependencies.now ?? Date.now;
  const deadline = await step.do("validate-window", { retries: { limit: 0, delay: "1 second" } }, async () => {
    const end = Date.parse(`${date}T09:25:00+08:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(end)
      || new Date(end + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10) !== date) {
      throw new Error("Invalid omo date");
    }
    return end;
  });
  let attempts = 0, errors = 0;
  let lastError = "";
  for (let index = 1; ; index++) {
    const attempt = await step.do(`poll-${index}`, {
      retries: { limit: 0, delay: "1 second" }, timeout: "15 seconds",
    }, async () => {
      const started = now();
      if (started >= deadline) return { expired: true, queried: false, error: "", bulletin: null, nextPollAt: deadline };
      const start = deadline - 300_000;
      if (started < start) return { expired: false, queried: false, error: "", bulletin: null, nextPollAt: start };
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const bulletin = await Promise.race([
          findOpenMarketBulletin(date, dependencies, abort.signal),
          new Promise<never>((_, reject) => { timer = setTimeout(() => {
            abort.abort(); reject(new Error("OMO query timed out"));
          }, Math.min(INTERVAL_MS, deadline - started)); }),
        ]);
        return { expired: now() >= deadline, queried: true, error: "", bulletin: now() < deadline ? bulletin : null,
          nextPollAt: Math.min(started + INTERVAL_MS, deadline) };
      } catch (error) {
        // Keep useful error type and status without forwarding upstream bodies or credentials.
        const message = error instanceof Error ? error.message : "Unknown query error";
        const status = message.match(/\b[45]\d{2}\b/)?.[0];
        const detail = /timed out|timeout/i.test(message) ? "OMO query timed out"
          : status ? `OMO upstream HTTP ${status}` : `OMO query failed (${error instanceof Error ? error.name : "Error"})`;
        return { expired: now() >= deadline, queried: true, error: detail, bulletin: null,
          nextPollAt: Math.min(started + INTERVAL_MS, deadline) };
      } finally { clearTimeout(timer); abort.abort(); }
    });
    if (attempt.queried) attempts++;
    if (attempt.error) { errors++; lastError = attempt.error; }
    if (attempt.bulletin) return { date, status: "found", attempts, errors, ...attempt.bulletin };
    if (attempt.expired) return await step.do("deadline-failure", { retries: { limit: 0, delay: "1 second" } }, async () => { throw new Error(
      `央行公开市场操作播报获取失败（${date}）：截至09:25未找到符合条件的当日播报；查询${attempts}次，失败${errors}次。${lastError ? `最后错误：${lastError}` : ""}`,
    ); });
    await step.sleepUntil(`wait-${index}`, new Date(attempt.nextPollAt));
  }
}

export class OmoWorkflow extends WorkflowEntrypoint<Env, OpenMarketParams> {
  override async run(event: Readonly<WorkflowEvent<OpenMarketParams>>, step: WorkflowStep) {
    return await runOmo(event.payload.date, step, {
      apiBaseUrl: this.env.ARTICLE_API_BASE_URL, fetcher: dataFetcher(this.env),
    });
  }
}
// Retain the previous namespace for instance history; Cron only creates omo instances.
export class OpenMarketWorkflow extends OmoWorkflow {}
