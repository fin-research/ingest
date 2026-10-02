import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { scheduledTradingDay } from "../src/trading-calendar";

afterEach(() => vi.restoreAllMocks());
const calendar = { date: "2026-10-01", isTradingDay: false, previousTradingDate: "2026-09-30" };
function bindings(payload: unknown = calendar, status = 200) {
  return { ARTICLE_API_BASE_URL: "https://eastmoney.hasbai.xyz/data", DATA: { fetch: vi.fn(async (_request: Request) => Response.json(payload, { status })) } };
}
it("holiday Cron stops every branch before collecting or creating workflows", async () => {
  const env = bindings();
  await worker.scheduled({ scheduledTime: Date.parse("2026-10-01T01:20:00Z"), cron: "*/5 0-9 * * MON-FRI" } as ScheduledController, env as unknown as Env);
  expect(env.DATA.fetch).toHaveBeenCalledTimes(1);
});
it.each(["2026-10-03T01:20:00Z", "2026-10-10T01:20:00Z"])("weekends including makeup workdays need no upstream query: %s", async timestamp => {
  const env = bindings();
  expect(await scheduledTradingDay(env as unknown as Env, Date.parse(timestamp))).toBe(false);
  expect(env.DATA.fetch).not.toHaveBeenCalled();
});
it("uses the scheduled Shanghai date even on a delayed delivery across midnight", async () => {
  const env = bindings({ date: "2026-09-30", isTradingDay: true, previousTradingDate: "2026-09-29" });
  expect(await scheduledTradingDay(env as unknown as Env, Date.parse("2026-09-29T16:00:00Z"))).toBe(true);
  const request = env.DATA.fetch.mock.calls[0]?.[0] as unknown as Request;
  // The binding receives a Request with its own cancellation signal.
  expect(new URL(request.url).searchParams.get("date")).toBe("2026-09-30");
});
it.each([
  [{ ...calendar, date: "2026-09-30" }, 200],
  [{ ...calendar, isTradingDay: "false" }, 200],
  [{ ...calendar, previousTradingDate: calendar.date }, 200],
  [calendar, 503],
])("calendar errors fail closed rather than dispatch", async (payload, status) => {
  const env = bindings(payload, status as number);
  await expect(scheduledTradingDay(env as unknown as Env, Date.parse("2026-10-01T01:20:00Z"))).rejects.toThrow();
});
