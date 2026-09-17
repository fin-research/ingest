import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { cleanOpenMarketContent, findOpenMarketBulletin, runOmo, startOpenMarketWorkflow } from "../src/open-market";
import type { Fetcher } from "../src/article";

const date = "2026-09-17";
const start = Date.parse(`${date}T09:20:00+08:00`);
const original = "中国央行今日开展1620亿元7天逆回购操作，投标量1620亿元，中标量1620亿元，操作利率为1.40%。同时，开展了6000亿元隔夜逆回购操作。DM数据显示，今日有30亿元7天期及6000亿元隔夜逆回购到期，当日实现净投放1590亿元。";
const cleaned = "中国央行今日开展1620亿元7天逆回购操作，操作利率为1.40%。同时，开展了6000亿元隔夜逆回购操作。今日有30亿元7天期及6000亿元隔夜逆回购到期，当日实现净投放1590亿元。";
const row = { sentimentId: "omo-1", title: "中国央行今日开展逆回购", time: `${date}T09:20:00+08:00`, tags: ["经济数据&政策"], important: true };
const apiBaseUrl = "https://example.com/data";

function clock(initial = start) {
  let time = initial;
  const waits: number[] = [], names: string[] = [];
  const step = {
    do: async (name: string, _config: unknown, fn: () => Promise<unknown>) => { names.push(name); return await fn(); },
    sleepUntil: async (_name: string, until: Date) => { waits.push(Math.max(0, until.valueOf() - time)); time = Math.max(time, until.valueOf()); },
  } as unknown as Parameters<typeof runOmo>[1];
  return { now: () => time, step, waits, names, set: (value: number) => { time = value; } };
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
    const result = await runOmo(date, time.step, { apiBaseUrl, fetcher, now: time.now });
    expect(result).toMatchObject({ status: "found", attempts: 3, errors: 1, text: cleaned.replace("净投放", "净回笼") });
    expect(time.waits).toEqual([10_000, 10_000]);
  });

  it.each(["empty", "http-error", "invalid-json"])("fails explicitly at 09:25 for %s", async (mode) => {
    const time = clock();
    const fetcher = vi.fn(async () => mode === "empty" ? Response.json([])
      : mode === "http-error" ? new Response("private details", { status: 503 }) : new Response("invalid"));
    await expect(runOmo(date, time.step, { apiBaseUrl, fetcher, now: time.now })).rejects.toThrow("截至09:25");
    expect(time.now()).toBe(start + 300_000);
    expect(fetcher).toHaveBeenCalledTimes(30);
    expect(time.names).toEqual(["validate-window", ...Array.from({ length: 31 }, (_, i) => `poll-${i + 1}`), "deadline-failure"]);
    await expect(runOmo(date, time.step, { apiBaseUrl, fetcher, now: time.now })).rejects.toThrow("查询0次");
    expect(fetcher).toHaveBeenCalledTimes(30);
  });

  it("rejects a response arriving after the deadline", async () => {
    const time = clock(start + 299_000);
    const fetcher: Fetcher = async input => {
      if (String(input).includes("/news?")) return Response.json([row]);
      time.set(start + 300_001);
      return Response.json({ content: original });
    };
    await expect(runOmo(date, time.step, { apiBaseUrl, fetcher, now: time.now })).rejects.toThrow("截至09:25");
  });

  it("starts only at weekday 09:20 with the same daily instance ID on repeated Cron delivery", async () => {
    const createBatch = vi.fn(async () => []);
    const binding = { OMO_WORKFLOW: { createBatch } } as unknown as Pick<Env, "OMO_WORKFLOW">;
    for (const value of [start, start, start - 300_000, start + 300_000, Date.parse("2026-09-19T09:20:00+08:00")]) {
      await startOpenMarketWorkflow(binding, value);
    }
    expect(createBatch).toHaveBeenCalledTimes(2);
    expect(createBatch).toHaveBeenLastCalledWith([{ id: "omo-2026-09-17", params: { date } }]);
  });

  it("accepts an existing daily instance after a duplicate or ambiguous create, but surfaces missing instances", async () => {
    const status = vi.fn(async () => ({ status: "running" }));
    const get = vi.fn(async () => ({ status }));
    const binding = { OMO_WORKFLOW: {
      createBatch: vi.fn(async () => { throw new Error("duplicate or connection interrupted"); }), get,
    } } as unknown as Pick<Env, "OMO_WORKFLOW">;
    await expect(startOpenMarketWorkflow(binding, start)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledWith(`omo-${date}`);
    expect(status).toHaveBeenCalledOnce();
    status.mockRejectedValueOnce(new Error("instance missing"));
    await expect(startOpenMarketWorkflow(binding, start)).rejects.toThrow("instance missing");
  });

  it("bounds a stalled query at the deadline and includes timeout detail", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start + 299_000);
    const step = { do: async (_name: string, _config: unknown, fn: () => Promise<unknown>) => await fn(), sleepUntil: vi.fn() } as unknown as Parameters<typeof runOmo>[1];
    const fetcher = vi.fn(async (): Promise<Response> => await new Promise(() => {}));
    const pending = expect(runOmo(date, step, { apiBaseUrl, fetcher })).rejects.toThrow("OMO query timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    vi.useRealTimers();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(step.sleepUntil).not.toHaveBeenCalled();
  });

  it("replays completed poll checkpoints without fetching again after the deadline", async () => {
    let now = start, queries = 0;
    const checkpoints = new Map<string, unknown>();
    const step = {
      do: async (name: string, _config: unknown, fn: () => Promise<unknown>) => {
        if (checkpoints.has(name)) return checkpoints.get(name);
        const value = await fn(); checkpoints.set(name, value); return value;
      },
      sleepUntil: async (_name: string, until: Date) => { now = until.valueOf(); },
    } as unknown as Parameters<typeof runOmo>[1];
    const fetcher: Fetcher = async input => {
      if (String(input).includes("/news?")) return Response.json(++queries === 1 ? [] : [row]);
      return Response.json({ content: original });
    };
    const result = await runOmo(date, step, { apiBaseUrl, fetcher, now: () => now });
    now = start + 3600_000;
    expect(await runOmo(date, step, { apiBaseUrl, fetcher, now: () => now })).toEqual(result);
    expect(queries).toBe(2);
  });

  it.each(["2020-01-01", "invalid-date", "2026-02-31"])("platform marks expired or invalid omo as errored: %s", async pollDate => {
    const id = `omo-${pollDate}-test`;
    const instance = await introspectWorkflowInstance(env.OMO_WORKFLOW, id);
    await env.OMO_WORKFLOW.create({ id, params: { date: pollDate } });
    await expect(instance.waitForStatus("errored")).resolves.toBeUndefined();
    const status = await (await env.OMO_WORKFLOW.get(id)).status();
    expect(status.error?.message).toContain(pollDate === "2020-01-01" ? "截至09:25" : "Invalid omo date");
    await instance.dispose();
  });
});
