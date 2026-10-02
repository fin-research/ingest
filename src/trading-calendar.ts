import { z } from "zod";
import { readJsonResponse } from "./article";
import { dataFetcher } from "./data-fetcher";

const calendarSchema = z.object({
  date: z.string().date(), isTradingDay: z.boolean(), previousTradingDate: z.string().date(),
});

/** A calendar outage stops dispatch; it never becomes evidence of a market closure. */
export async function scheduledTradingDay(env: Pick<Env, "DATA" | "ARTICLE_API_BASE_URL">, scheduledTime: number): Promise<boolean> {
  const local = new Date(scheduledTime + 8 * 3600_000);
  const date = local.toISOString().slice(0, 10);
  if ([0, 6].includes(local.getUTCDay())) return false;
  try {
    const url = new URL(`${env.ARTICLE_API_BASE_URL.replace(/\/$/, "")}/trading-days`);
    url.search = new URLSearchParams({ date, fields: "date,isTradingDay,previousTradingDate" }).toString();
    const response = await dataFetcher(env)(url, { signal: AbortSignal.timeout(10_000) });
    const calendar = calendarSchema.parse(await readJsonResponse(response, "Trading calendar"));
    if (calendar.date !== date || calendar.previousTradingDate >= date) throw new Error("Trading calendar date mismatch");
    if (!calendar.isTradingDay) console.log(JSON.stringify({ event: "ingest_cron_skipped", date, reason: "market_closed" }));
    return calendar.isTradingDay;
  } catch (error) {
    console.error(JSON.stringify({ event: "ingest_calendar_unavailable", date }));
    throw error;
  }
}
