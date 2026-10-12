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

afterEach(() => vi.unstubAllGlobals());

describe("loadStatusViews 缓存", () => {
  test("TTL 内重复调用不再拉状态接口", async () => {
    const counter = { n: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/status/latest")) return json({ sudocode: {} });
        if (url.includes("/api/status?")) {
          counter.n += 1;
          return json({ records: [] });
        }
        return json({ records: [] });
      }),
    );
    const mod = await freshModule();

    await mod.loadStatusViews();
    const afterFirst = counter.n;
    await mod.loadStatusViews();

    expect(afterFirst).toBeGreaterThan(0);
    expect(counter.n).toBe(afterFirst); // 第二次命中缓存，没有新增请求
  });

  test("超过 TTL 先返回旧结果、后台再刷新（stale-while-revalidate）", async () => {
    const counter = { n: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/status/latest")) return json({ sudocode: {} });
        if (url.includes("/api/status?")) {
          counter.n += 1;
          return json({ records: [] });
        }
        return json({ records: [] });
      }),
    );
    const mod = await freshModule();

    const first = await mod.loadStatusViews();
    const callsAfterFirst = counter.n;

    // 快进超过 TTL：本次调用应立刻拿到与上次相同的结果，并触发一次后台刷新
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    const stale = await mod.loadStatusViews();
    vi.useRealTimers();

    expect(stale).toBe(first); // 返回缓存里的旧结果，不阻塞本次请求

    // 后台刷新是在下一个微任务里才发出请求的，稍等一拍再核对它确实启动了
    await new Promise((r) => setTimeout(r, 20));
    expect(counter.n).toBeGreaterThan(callsAfterFirst); // 后台刷新确实发起了

    // 后台刷新落定后再取一次：拿到刷新后的新结果，而不是永远停在旧值
    const refreshed = await mod.loadStatusViews();
    expect(refreshed).not.toBe(first);
  });

  test("过期触发后台刷新时，紧随其后的请求仍拿旧值、不等刷新", async () => {
    let slow = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/status/latest")) return json({ sudocode: {} });
        if (url.includes("/api/status?")) {
          if (slow) await new Promise((r) => setTimeout(r, 60));
          return json({ records: [] });
        }
        return json({ records: [] });
      }),
    );
    const mod = await freshModule();

    // 用可调的 Date.now 快进时间戳判断 TTL 过期，避免假定时器干扰后台刷新的 setTimeout
    const realNow = Date.now;
    let offset = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + offset);

    const first = await mod.loadStatusViews();

    // 让下一次「现算」变慢，并快进超过 TTL：此刻的请求会触发一次慢的后台刷新
    slow = true;
    offset = 61_000;
    const a = await mod.loadStatusViews();
    // 刷新还在飞时，紧接着的请求也必须立刻拿到旧值，而不是等它完成
    const b = await mod.loadStatusViews();

    expect(a).toBe(first);
    expect(b).toBe(first);
    spy.mockRestore();
  });

  test("现算失败会丢弃缓存，下一次重新计算、不会固化失败", async () => {
    let bad = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/status/latest")) return json({ sudocode: {} });
        if (url.includes("/api/status?")) return json({ records: [] });
        // overview 记录里 model 缺失会在 buildMonitoredSets 抛错 → 现算整体失败
        if (url.includes("/api/overview")) return json(bad ? { records: [{}] } : { records: [] });
        return json({ records: [] });
      }),
    );
    const mod = await freshModule();

    await expect(mod.loadStatusViews()).rejects.toThrow();
    bad = false;
    // 上一次失败必须被丢弃，否则这里会一直命中失败的缓存
    const views = await mod.loadStatusViews();
    expect(views).toBeTruthy();
  });
});
