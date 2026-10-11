/** 采集出口下拉的纯函数口径：组选项、节点候选、切换范围标签与关键词串互转。 */
import { describe, expect, it } from "vitest";

import {
  filterToTags,
  findGroup,
  groupOptionLabel,
  groupOptions,
  groupTypeLabel,
  nodeOptions,
  tagsToFilter,
  type ProxyGroupInfo,
} from "@/lib/proxyGroups";

function group(overrides: Partial<ProxyGroupInfo>): ProxyGroupInfo {
  return {
    name: "PROXY",
    type: "Selector",
    now: "香港01",
    builtin: false,
    nodes: [{ name: "香港01", info: false, group: false }],
    ...overrides,
  };
}

describe("groupTypeLabel / groupOptionLabel", () => {
  it("认识的类型给中文说明，不认识的类型原样显示", () => {
    expect(groupTypeLabel("Selector")).toBe("手动选择");
    expect(groupTypeLabel("URLTest")).toBe("自动测速");
    expect(groupTypeLabel("Relay")).toBe("链式代理");
    expect(groupTypeLabel("Future")).toBe("Future");
    expect(groupTypeLabel("")).toBe("未知类型");
  });

  it("一行说明带类型、现用节点；内置组标注仅全局模式生效", () => {
    expect(groupOptionLabel(group({}))).toBe("PROXY（手动选择 · 现用 香港01）");
    expect(groupOptionLabel(group({ builtin: true, type: "", now: "" }))).toBe("PROXY（未知类型 · 仅全局模式生效）");
  });
});

describe("groupOptions", () => {
  it("当前填写值不在接口清单里时兜底成第一个选项，避免填了却看不见", () => {
    const options = groupOptions([group({ name: "宝可梦" })], "良心云");
    expect(options[0]).toEqual({ value: "良心云", label: "良心云（当前填写，接口里没读到这个组）" });
    expect(options).toHaveLength(2);
  });

  it("当前值就在清单里时不重复出现", () => {
    const options = groupOptions([group({ name: "PROXY" })], "PROXY");
    expect(options).toHaveLength(1);
  });
});

describe("nodeOptions", () => {
  it("过滤信息位，子组标注「分组」；组不在清单里给空数组（只能手填关键词）", () => {
    const groups = [
      group({
        name: "宝可梦",
        nodes: [
          { name: "自动选择", info: false, group: true },
          { name: "剩余流量：59 GB", info: true, group: false },
          { name: "香港01", info: false, group: false },
        ],
      }),
    ];
    expect(nodeOptions(groups, "宝可梦")).toEqual([
      { id: "自动选择", note: "分组" },
      { id: "香港01" },
    ]);
    expect(nodeOptions(groups, "不存在的组")).toEqual([]);
  });
});

describe("filterToTags / tagsToFilter", () => {
  it("中英文逗号都认，空白片段丢弃；标签串接回库里格式", () => {
    expect(filterToTags("香港, hk，日本高速 ")).toEqual(["香港", "hk", "日本高速"]);
    expect(filterToTags("")).toEqual([]);
    expect(tagsToFilter(["香港", "hk"])).toBe("香港,hk");
    // 完整节点名也是合法关键词（名字是它自己的子串），往返不失真
    const node = "🇭🇰【亚洲】香港05原生丨移动直连";
    expect(filterToTags(tagsToFilter([node]))).toEqual([node]);
  });
});

describe("findGroup", () => {
  it("按组名找组，找不到返回 undefined", () => {
    const groups = [group({ name: "PROXY" })];
    expect(findGroup(groups, "PROXY")?.now).toBe("香港01");
    expect(findGroup(groups, "没有")).toBeUndefined();
  });
});
