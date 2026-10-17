import { afterEach, describe, expect, test, vi } from "vitest";

/** 极简 Response 替身：只要 ok / status / json()，够 apiGet 用。 */
function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** 每个用例拿到一份全新的模块（缓存是模块级变量，必须隔离）。 */
async function freshModule() {
  vi.resetModules();
  return await import("@/lib/statusData");
}

/** 每次返回一份全新的空摘要：SWR 用例靠对象身份判断「拿到的是新结果」。 */
function summaryBody() {
  return { sites: {} };
}

/** 默认 mock：/api/status/summary 返回空摘要；onViews 可定制耗时或失败。 */
function stubFetch(counter: { n: number }, onViews?: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/status/summary")) {
        counter.n += 1;
        if (onViews) return await onViews(url);
        return json(summaryBody());
      }
      return json({ records: [] });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadSiteChannelSummary 缓存", () => {
  test("TTL 内重复调用不再拉视图接口", async () => {
    const counter = { n: 0 };
    stubFetch(counter);
    const mod = await freshModule();

    await mod.loadSiteChannelSummary();
    const afterFirst = counter.n;
    await mod.loadSiteChannelSummary();

    expect(afterFirst).toBeGreaterThan(0);
    expect(counter.n).toBe(afterFirst); // 第二次命中缓存，没有新增请求
  });

  test("超过 TTL 先返回旧结果、后台再刷新（stale-while-revalidate）", async () => {
    const counter = { n: 0 };
    stubFetch(counter);
    const mod = await freshModule();

    const first = await mod.loadSiteChannelSummary();
    const callsAfterFirst = counter.n;

    // 用可调的 Date.now 快进时间戳判断 TTL 过期，避免假定时器干扰后台刷新
    const realNow = Date.now;
    let offset = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + offset);
    offset = 6 * 60_000; // 越过 5 分钟 TTL

    const stale = await mod.loadSiteChannelSummary();
    expect(stale).toBe(first); // 先给旧结果，不阻塞本次请求

    await new Promise((r) => setTimeout(r, 20));
    expect(counter.n).toBeGreaterThan(callsAfterFirst); // 后台刷新确实发起了

    const refreshed = await mod.loadSiteChannelSummary();
    expect(refreshed).not.toBe(first); // 刷新落定后取到新结果，不会永远停在旧值
    spy.mockRestore();
  });

  test("过期触发后台刷新时，紧随其后的请求仍拿旧值、不等刷新", async () => {
    let slow = false;
    const counter = { n: 0 };
    stubFetch(counter, async () => {
      if (slow) await new Promise((r) => setTimeout(r, 60));
      return json(summaryBody());
    });
    const mod = await freshModule();

    const realNow = Date.now;
    let offset = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + offset);

    const first = await mod.loadSiteChannelSummary();

    slow = true;
    offset = 6 * 60_000;
    const a = await mod.loadSiteChannelSummary();
    // 刷新还在飞时，紧接着的请求也必须立刻拿到旧值，而不是等它完成
    const b = await mod.loadSiteChannelSummary();

    expect(a).toBe(first);
    expect(b).toBe(first);
    spy.mockRestore();
  });

  test("现算失败会丢弃缓存，下一次重新计算、不会固化失败", async () => {
    let bad = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/status/summary")) {
          if (bad) throw new Error("backend down");
          return json(summaryBody());
        }
        return json({ records: [] });
      }),
    );
    const mod = await freshModule();

    await expect(mod.loadSiteChannelSummary()).rejects.toThrow();
    bad = false;
    const summary = await mod.loadSiteChannelSummary();
    expect(summary).toBeTruthy();
  });
});
