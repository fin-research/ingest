import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { fetchOpenMarketNews, fetchResearchReportDetail, type Fetcher } from "./article";
import { dataFetcher } from "./data-fetcher";
import { MessengerNotifier } from "./telegram";

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
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function startOpenMarketWorkflow(
  env: Pick<Env, "OPEN_MARKET_WORKFLOW">,
  scheduledTime: number,
): Promise<void> {
  const shanghai = new Date(scheduledTime + SHANGHAI_OFFSET_MS);
  const weekday = shanghai.getUTCDay();
  if (weekday === 0 || weekday === 6 || shanghai.getUTCHours() !== 9 || shanghai.getUTCMinutes() !== 20) return;
  const date = shanghai.toISOString().slice(0, 10);
  // A daily ID prevents duplicate Cron deliveries from creating another poller.
  const id = `open-market-${date}`;
  const [creation] = await Promise.allSettled([env.OPEN_MARKET_WORKFLOW.createBatch([{ id, params: { date } }])]);
  if (creation.status === "fulfilled") return;
  // Also resolves an ambiguous create response after the instance was persisted.
  const existing = await env.OPEN_MARKET_WORKFLOW.get(id);
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

export async function pollOpenMarket(date: string, dependencies: PollDependencies): Promise<OpenMarketResult> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => scheduler.wait(milliseconds));
  const start = Date.parse(`${date}T09:20:00+08:00`);
  const deadline = Date.parse(`${date}T09:25:00+08:00`);
  if (!Number.isFinite(deadline)) throw new Error("Invalid open market date");
  let attempts = 0;
  let errors = 0;
  let pending: { promise: ReturnType<typeof findOpenMarketBulletin>; abort: AbortController; settled: boolean } | undefined;
  if (now() < start) await sleep(start - now());
  while (now() < deadline) {
    const attemptStart = now();
    if (!pending || pending.settled) {
      const abort = new AbortController();
      const current = { promise: findOpenMarketBulletin(date, dependencies, abort.signal), abort, settled: false };
      current.promise = current.promise.then(
        value => { current.settled = true; return value; },
        error => { current.settled = true; throw error; },
      );
      pending = current;
    }
    const active = pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bound the whole list/detail/body attempt, including stalled Service Bindings.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        active.abort.abort();
        reject(new Error("Open market query timed out"));
      }, Math.min(INTERVAL_MS, deadline - attemptStart));
    });
    const [result] = await Promise.allSettled([
      Promise.race([active.promise, timeout]),
    ]);
    clearTimeout(timer);
    active.abort.abort();
    attempts += 1;
    if (result.status === "rejected") errors += 1;
    else if (result.value && now() < deadline) {
      return { date, status: "found", attempts, errors, ...result.value };
    }
    const remaining = Math.min(attemptStart + INTERVAL_MS, deadline) - now();
    if (remaining > 0) await sleep(remaining);
  }
  return {
    date, status: errors > 0 ? "failed" : "not_found", attempts, errors,
    text: errors > 0
      ? `央行公开市场操作播报获取失败（${date}）：截至09:25未获取到符合条件的播报，查询失败${errors}次。`
      : `央行公开市场操作播报获取失败（${date}）：截至09:25未找到符合条件的当日播报。`,
  };
}

export class OpenMarketWorkflow extends WorkflowEntrypoint<Env, OpenMarketParams> {
  override async run(event: Readonly<WorkflowEvent<OpenMarketParams>>, step: WorkflowStep) {
    const result = await step.do("loop", { retries: { limit: 0, delay: "1 second" }, timeout: "6 minutes" }, async () => {
      const [outcome] = await Promise.allSettled([
        Promise.resolve().then(async () => await pollOpenMarket(event.payload.date, {
          apiBaseUrl: this.env.ARTICLE_API_BASE_URL, fetcher: dataFetcher(this.env),
        })),
      ]);
      if (outcome.status === "fulfilled") return outcome.value;
      return {
        date: event.payload.date, status: "failed", attempts: 0, errors: 1,
        text: `央行公开市场操作播报获取失败（${event.payload.date}）：轮询异常。`,
      } satisfies OpenMarketResult;
    });
    return await step.do("notify", {
      retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes",
    }, async () => {
      const messengerId = await new MessengerNotifier(this.env.MESSENGER).sendText(`open-market/${result.date}`, result.text);
      return { ...result, messengerId, delivery: "submitted" };
    });
  }
}
