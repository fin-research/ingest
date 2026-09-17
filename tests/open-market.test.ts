import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { cleanOpenMarketContent, findOpenMarketBulletin, pollOpenMarket, startOpenMarketWorkflow } from "../src/open-market";
import { MessengerNotifier } from "../src/telegram";
import type { Fetcher } from "../src/article";

const date = "2026-09-17";
const start = Date.parse(`${date}T09:20:00+08:00`);
const original = "中国央行今日开展1620亿元7天逆回购操作，投标量1620亿元，中标量1620亿元，操作利率为1.40%。同时，开展了6000亿元隔夜逆回购操作。DM数据显示，今日有30亿元7天期及6000亿元隔夜逆回购到期，当日实现净投放1590亿元。";
const cleaned = "中国央行今日开展1620亿元7天逆回购操作，操作利率为1.40%。同时，开展了6000亿元隔夜逆回购操作。今日有30亿元7天期及6000亿元隔夜逆回购到期，当日实现净投放1590亿元。";
const row = { sentimentId: "omo-1", title: "中国央行今日开展逆回购", time: `${date}T09:20:00+08:00`, tags: ["经济数据&政策"], important: true };
const apiBaseUrl = "https://example.com/data";

function clock() {
  let time = start;
  const waits: number[] = [];
  return { now: () => time, sleep: async (milliseconds: number) => { waits.push(milliseconds); time += milliseconds; }, waits };
}

describe("open market bulletin", () => {
  it("cleans the supplied bulletin without changing operation, maturity or net amount", () => {
    expect(cleanOpenMarketContent(original)).toBe(cleaned);
    expect(cleanOpenMarketContent(cleaned)).toBe(cleaned);
    expect(cleanOpenMarketContent("中国央行开展操作，投标量为1,620亿元，中标量：1620亿元。DM数据显示：今日净回笼30亿元。"))
      .toBe("中国央行开展操作。今日净回笼30亿元。");
  });

  it("requests today's important tagged news and checks date, title, tag, importance and body", async () => {
    const paths: string[] = [];
    const fetcher: Fetcher = async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/data/news") {
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ date, tag: "经济数据&政策", important: "true", pageSize: "100" });
        expect(url.searchParams.get("fields")).toContain("important");
        return Response.json([
          { ...row, sentimentId: "yesterday", time: "2026-09-16T09:20:00+08:00" },
          { ...row, sentimentId: "other", title: "其他央行" },
          { ...row, sentimentId: "wrong-tag", tags: ["政策"] },
          { ...row, sentimentId: "unimportant", important: false },
          { ...row, sentimentId: "broken-detail" },
          { ...row, sentimentId: "no-net" }, row,
        ]);
      }
      if (url.pathname.endsWith("broken-detail")) return new Response(null, { status: 503 });
      return Response.json({ content: url.pathname.endsWith("no-net") ? "中国央行今日开展逆回购操作。" : original });
    };
    await expect(findOpenMarketBulletin(date, { apiBaseUrl, fetcher }, new AbortController().signal))
      .resolves.toEqual({ articleId: "omo-1", text: cleaned });
    expect(paths).toEqual(["/data/news", "/data/news/broken-detail", "/data/news/no-net", "/data/news/omo-1"]);
  });

  it("retries every 10 seconds through transient failures and stops immediately on a match", async () => {
    const time = clock();
    let requests = 0;
    const fetcher: Fetcher = async (input) => {
      if (String(input).includes("/news?")) {
        requests += 1;
        if (requests === 1) throw new Error("upstream secret must never be sent");
        return Response.json(requests === 2 ? [] : [row]);
      }
      return Response.json({ content: original.replace("净投放", "净回笼") });
    };
    const result = await pollOpenMarket(date, { apiBaseUrl, fetcher, ...time });
    expect(result).toMatchObject({ status: "found", attempts: 3, errors: 1, text: cleaned.replace("净投放", "净回笼") });
    expect(time.waits).toEqual([10_000, 10_000]);
  });

  it.each(["empty", "http-error", "invalid-json"])("returns a notification result at 09:25 for %s", async (mode) => {
    const time = clock();
    const fetcher = vi.fn(async () => mode === "empty" ? Response.json([])
      : mode === "http-error" ? new Response("private upstream details", { status: 503 }) : new Response("invalid"));
    const result = await pollOpenMarket(date, { apiBaseUrl, fetcher, ...time });
    expect(result).toMatchObject({ status: mode === "empty" ? "not_found" : "failed", attempts: 30, errors: mode === "empty" ? 0 : 30 });
    expect(result.text).toContain("截至09:25");
    expect(result.text).not.toContain("private");
    expect(time.now()).toBe(start + 300_000);
    expect(fetcher).toHaveBeenCalledTimes(30);
    await expect(pollOpenMarket(date, { apiBaseUrl, fetcher, ...time })).resolves.toMatchObject({ attempts: 0 });
    expect(fetcher).toHaveBeenCalledTimes(30);
  });

  it("does not accept a response arriving after the deadline", async () => {
    let time = start + 299_000;
    const fetcher: Fetcher = async (input) => {
      if (String(input).includes("/news?")) return Response.json([row]);
      time = start + 300_001;
      return Response.json({ content: original });
    };
    await expect(pollOpenMarket(date, { apiBaseUrl, fetcher, now: () => time })).resolves.toMatchObject({ status: "not_found", attempts: 1 });
  });

  it("starts only at weekday 09:20 with the same daily instance ID on repeated Cron delivery", async () => {
    const createBatch = vi.fn(async () => []);
    const binding = { OPEN_MARKET_WORKFLOW: { createBatch } } as unknown as Pick<Env, "OPEN_MARKET_WORKFLOW">;
    for (const value of [start, start, start - 300_000, start + 300_000, Date.parse("2026-09-19T09:20:00+08:00")]) {
      await startOpenMarketWorkflow(binding, value);
    }
    expect(createBatch).toHaveBeenCalledTimes(2);
    expect(createBatch).toHaveBeenLastCalledWith([{ id: "open-market-2026-09-17", params: { date } }]);
  });

  it("submits both successful and failed loop results to Telegram with a stable daily key", async () => {
    const payloads: unknown[] = [];
    const notifier = new MessengerNotifier({ fetch: async (request) => {
      payloads.push(await request.json());
      return Response.json({ id: "message-1" }, { status: 202 });
    } });
    for (const text of [cleaned, "央行公开市场操作播报获取失败"]) await notifier.sendText(`open-market/${date}`, text);
    expect(payloads).toEqual([cleaned, "央行公开市场操作播报获取失败"].map(text => ({ source: "ingest", channel: "telegram", idempotencyKey: `open-market/${date}`, text })));
    await expect(new MessengerNotifier({ fetch: async () => new Response(null, { status: 503 }) }).sendText("open-market/test", cleaned)).rejects.toThrow("503");
  });

  it("accepts an existing daily instance after a duplicate or ambiguous create, but surfaces missing instances", async () => {
    const status = vi.fn(async () => ({ status: "running" }));
    const get = vi.fn(async () => ({ status }));
    const binding = { OPEN_MARKET_WORKFLOW: {
      createBatch: vi.fn(async () => { throw new Error("duplicate or connection interrupted"); }), get,
    } } as unknown as Pick<Env, "OPEN_MARKET_WORKFLOW">;
    await expect(startOpenMarketWorkflow(binding, start)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledWith(`open-market-${date}`);
    expect(status).toHaveBeenCalledOnce();
    status.mockRejectedValueOnce(new Error("instance missing"));
    await expect(startOpenMarketWorkflow(binding, start)).rejects.toThrow("instance missing");
  });

  it("bounds a stalled binding to one in-flight query and still returns a failure at the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const fetcher = vi.fn(async (): Promise<Response> => await new Promise(() => {}));
    const pending = pollOpenMarket(date, { apiBaseUrl, fetcher, sleep: async ms => await new Promise(resolve => setTimeout(resolve, ms)) });
    await vi.advanceTimersByTimeAsync(300_000);
    const result = await pending;
    vi.useRealTimers();
    expect(result).toMatchObject({ status: "failed", errors: 30 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["2020-01-01", "invalid-date"])("runs loop then notify with the actual loop result for %s", async (pollDate) => {
    const id = `open-market-${pollDate}-test`;
    const instance = await introspectWorkflowInstance(env.OPEN_MARKET_WORKFLOW, id);
    await env.OPEN_MARKET_WORKFLOW.create({ id, params: { date: pollDate } });
    const loop = z.object({ text: z.string(), status: z.string(), attempts: z.number() }).parse(await instance.waitForStepResult({ name: "loop" }));
    expect(loop).toMatchObject({ status: pollDate === "invalid-date" ? "failed" : "not_found", attempts: 0 });
    const notify = await instance.waitForStepResult({ name: "notify" });
    expect(notify).toMatchObject({ ...loop, delivery: "submitted", messengerId: `test:${loop.text}` });
    await expect(instance.waitForStatus("complete")).resolves.toBeUndefined();
    await instance.dispose();
  });
});
