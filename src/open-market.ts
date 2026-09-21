import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { fetchOpenMarketNews, fetchResearchReportDetail, readJsonResponse, type Fetcher } from "./article";
import { dataFetcher } from "./data-fetcher";

export const OMO_STEP_CONFIG = {
  retries: { limit: 20, delay: "15 seconds", backoff: "constant" },
  timeout: "15 seconds",
} as const;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface OpenMarketParams { date: string; scheduledStart?: string }
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
}

export async function startOpenMarketWorkflow(
  env: Pick<Env, "OMO_WORKFLOW">,
  scheduledTime: number,
): Promise<void> {
  const shanghai = new Date(scheduledTime + SHANGHAI_OFFSET_MS);
  const weekday = shanghai.getUTCDay();
  if (weekday === 0 || weekday === 6 || shanghai.getUTCHours() !== 9 || ![10, 15, 20].includes(shanghai.getUTCMinutes())) return;
  const date = shanghai.toISOString().slice(0, 10);
  // A daily ID prevents duplicate Cron deliveries from creating another poller.
  const id = `omo-${date}`;
  const [creation] = await Promise.allSettled([env.OMO_WORKFLOW.createBatch([{ id, params: { date, scheduledStart: `${date}T09:20:00+08:00` } }])]);
  if (creation.status === "fulfilled") return;
  // Also resolves an ambiguous create response after the instance was persisted.
  const existing = await env.OMO_WORKFLOW.get(id);
  await existing.status();
}

export function cleanOpenMarketContent(content: string): string {
  return content
    .replace(/(?:其中[，,]?\s*)?(?:投标量|中标量)\s*(?:为|是|[:：])?\s*[\d,，]+(?:\.\d+)?\s*(?:万亿|亿|万)?元\s*[，,；;]?\s*/g, "")
    .replace(/(?:【|\[)?(?:据\s*)?DM\s*数据显示[\s\S]*$/i, "")
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
    const text = cleanOpenMarketContent(detail.content);
    if (!text || text.length > 4096) { detailErrors += 1; continue; }
    // An unrelated central-bank headline must not become an OMO bulletin.
    try { injectionAmount(text); } catch { continue; }
    return { articleId: article.id, text };
  }
  if (detailErrors > 0) throw new Error("Open market bulletin details unavailable");
  return null;
}

const operationSchema = z.object({
  operationDate: z.string().date(),
  operationName: z.string().nullable(),
  duration: z.string().nullable(),
  operationAmount: z.number().finite().nullable(),
});

/** Amounts come only from the cleaned announcement, never the API's injection rows. */
function injectionAmount(text: string): number {
  const amounts = [...text.matchAll(/([\d,，]+(?:\.\d+)?)\s*(万亿|亿|万)?元/g)];
  if (!amounts.length && /(?:不开展|未开展|暂停)(?:公开市场)?(?:逆回购|操作)/.test(text)) return 0;
  if (!amounts.length || /净投放|净回笼|到期/.test(text)) throw new Error("OMO injection amount unavailable");
  let total = 0;
  for (const match of amounts) {
    const suffix = text.slice(match.index! + match[0].length);
    if (!/^\s*(?:(?:\d+(?:\.\d+)?(?:天|日|个月|月|年)(?:期)?|隔夜)\s*)?(?:买断式逆回购|逆回购|MLF|中期借贷便利|(?:的)?(?:公开市场)?操作)/i.test(suffix)) {
      throw new Error("OMO injection amount is ambiguous");
    }
    const value = Number(match[1]!.replace(/[,，]/g, ""));
    const scale = match[2] === "万亿" ? 10_000 : match[2] === "亿" ? 1 : match[2] === "万" ? 0.0001 : 0.00000001;
    total += value * scale;
  }
  if (!Number.isFinite(total)) throw new Error("Invalid OMO injection amount");
  return total;
}

const amountText = (value: number) => String(Number(value.toFixed(8)));
function durationText(value: string | null): string {
  if (!value) throw new Error("OMO maturity duration unavailable");
  if (/^(?:隔夜|O\/N|ON|1D)$/i.test(value)) return "隔夜";
  return value.replace(/^(\d+)D$/i, "$1天期").replace(/^(\d+)M$/i, "$1个月期")
    .replace(/^(\d+)Y$/i, "$1年期").replace(/^(\d+)(天|日|个月|月|年)$/, "$1$2期");
}

export function buildOpenMarketText(date: string, text: string, payload: unknown): string {
  const rows = z.array(operationSchema).parse(payload);
  if (!rows.length) throw new Error("OMO data unavailable for today");
  if (rows.some(row => row.operationDate !== date)) throw new Error("OMO operation date mismatch");
  const maturities = new Map<string, { name: string; term: string; amount: number }>();
  for (const row of rows) {
    if (!row.operationName) throw new Error("OMO operation name unavailable");
    // Positive API injections (including treasury deposits) are not the news amount.
    // Repo maturities can be signed or unsigned; reverse-repo maturity always drains.
    if (!row.operationName.includes("到期") || row.operationName === "正回购到期") continue;
    if (row.operationAmount === null) throw new Error("OMO maturity amount unavailable");
    const name = row.operationName.replace(/到期/g, "").trim();
    const term = durationText(row.duration);
    const key = `${name}/${term}`;
    const previous = maturities.get(key);
    maturities.set(key, { name, term, amount: (previous?.amount ?? 0) + Math.abs(row.operationAmount) });
  }
  const entries = [...maturities.values()];
  // A partial upstream response must not silently become zero maturities.
  // A day with no maturities needs an explicit zero-valued maturity record.
  if (!entries.length) throw new Error("OMO maturity data unavailable for today");
  const maturity = entries.reduce((sum, row) => sum + row.amount, 0);
  const net = Number((injectionAmount(text) - maturity).toFixed(8));
  const expiry = maturity !== 0 ? `今日有${entries.map((row, index) =>
    `${amountText(row.amount)}亿元${row.term}${entries[index + 1]?.name === row.name ? "" : row.name}`).join("及")}到期`
    : "今日无公开市场操作到期";
  const balance = net === 0 ? "当日投放与回笼量持平。"
    : `当日实现净${net > 0 ? "投放" : "回笼"}${amountText(Math.abs(net))}亿元。`;
  return `${text.replace(/[。\s]+$/, "")}。${expiry}，${balance}`;
}

/** Exactly two checkpoints. Missing news throws so Workflows owns all retries. */
export async function runOmo(date: string, step: Pick<WorkflowStep, "do">, dependencies: PollDependencies): Promise<OpenMarketResult> {
  const parsedDate = Date.parse(`${date}T00:00:00Z`);
  const bulletin = await step.do("获取并清洗央行投放公告", OMO_STEP_CONFIG, async context => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate)
      || new Date(parsedDate).toISOString().slice(0, 10) !== date) {
      throw new NonRetryableError("Invalid omo date");
    }
    console.log(JSON.stringify({ event: "omo_bulletin_attempt", date, attempt: context.attempt,
      targetAt: `${date}T09:20:00+08:00`, startedAt: new Date().toISOString(),
      delayMs: Date.now() - Date.parse(`${date}T09:20:00+08:00`) }));
    const result = await queryWithTimeout(signal => findOpenMarketBulletin(date, dependencies, signal));
    if (!result) throw new Error(`尚未获取当日央行投放公告（${date}），等待 Workflow 重试`);
    return { ...result, attempts: context.attempt, errors: context.attempt - 1 };
  });
  return await step.do("查询到期回笼并生成播报", OMO_STEP_CONFIG, async () => {
    const text = await queryWithTimeout(async signal => {
      const url = new URL(`${dependencies.apiBaseUrl.replace(/\/$/, "")}/omo`);
      url.search = new URLSearchParams({ startDate: date, endDate: date }).toString();
      const response = await dependencies.fetcher(url, { headers: { Accept: "application/json" }, signal });
      return buildOpenMarketText(date, bulletin.text, await readJsonResponse(response, "OMO operations"));
    });
    return { date, status: "found" as const, ...bulletin, text };
  });

  async function queryWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        operation(abort.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          abort.abort(); reject(new Error("OMO query timed out"));
        }, 10_000); }),
      ]);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown query error";
      const status = message.match(/\b[45]\d{2}\b/)?.[0];
      const detail = /timed out|timeout/i.test(message) ? "OMO query timed out"
        : status ? `OMO upstream HTTP ${status}` : `OMO query failed (${error instanceof Error ? error.name : "Error"})`;
      throw new Error(detail);
    } finally { clearTimeout(timer); abort.abort(); }
  }
}

export class OmoWorkflow extends WorkflowEntrypoint<Env, OpenMarketParams> {
  override async run(event: Readonly<WorkflowEvent<OpenMarketParams>>, step: WorkflowStep) {
    return await runScheduledOmo(event.payload, step, {
      apiBaseUrl: this.env.ARTICLE_API_BASE_URL, fetcher: dataFetcher(this.env),
    });
  }
}

/** Prepare before the business time so Cron jitter does not delay instance creation. */
export async function runScheduledOmo(
  params: OpenMarketParams,
  step: Pick<WorkflowStep, "do" | "sleepUntil">,
  dependencies: PollDependencies,
): Promise<OpenMarketResult> {
  if (params.scheduledStart !== undefined) {
    const target = `${params.date}T09:20:00+08:00`;
    if (!z.string().date().safeParse(params.date).success || params.scheduledStart !== target) {
      throw new NonRetryableError("Invalid omo scheduled start");
    }
    await step.sleepUntil("等待北京时间09:20", new Date(target));
  }
  return await runOmo(params.date, step, dependencies);
}
