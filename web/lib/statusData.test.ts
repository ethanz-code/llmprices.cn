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

/** 一条能让 channelStatus 解析出「一个正常渠道」的最新快照。 */
const healthySnapshot = (site: string, at: number) => ({
  site_id: site,
  captured_at: at,
  data: { channels: [{ name: "gpt-6", status: "up" }] },
});

afterEach(() => vi.unstubAllGlobals());

describe("loadLatestStatus", () => {
  test("按站给出此刻可用率，且 TTL 内重复调用不再拉最新状态", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/status/latest")) {
          calls += 1;
          return json({ sudocode: healthySnapshot("sudocode", 1_700_000_000) });
        }
        return json({});
      }),
    );
    const mod = await freshModule();

    const first = await mod.loadLatestStatus();
    expect(first.sudocode).toEqual({ pct: 100, down: 0, checks: 1, at: 1_700_000_000 });

    const afterFirst = calls;
    const second = await mod.loadLatestStatus();
    expect(calls).toBe(afterFirst); // 命中缓存，没有再拉
    expect(second).toBe(first);
  });

  test("最新状态接口失败时返回空表、不抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const mod = await freshModule();
    await expect(mod.loadLatestStatus()).resolves.toEqual({});
  });
});
