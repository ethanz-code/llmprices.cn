/** 控制接口（Clash/mihomo External Controller）读回来的组与节点清单：
 *  面板下拉选组、勾节点用。纯函数放这里，UI 只负责摆位置。 */

export type ProxyNodeInfo = {
  name: string;
  /** 机场塞在组里的信息位（剩余流量/套餐到期这类），不是真节点 */
  info: boolean;
  /** 该成员本身还是个策略组（选它 = 让那个组自己决定出口） */
  group: boolean;
};

export type ProxyGroupInfo = {
  name: string;
  type: string;
  /** 该组当前实际在用的节点 */
  now: string;
  /** 内置的 GLOBAL 组：规则模式下改它没用，仅全局模式生效 */
  builtin: boolean;
  nodes: ProxyNodeInfo[];
};

export type ProxyGroupsResponse = { groups: ProxyGroupInfo[] };

const GROUP_TYPE_LABELS: Record<string, string> = {
  Selector: "手动选择",
  URLTest: "自动测速",
  Fallback: "自动回退",
  LoadBalance: "负载均衡",
  Relay: "链式代理",
};

export function groupTypeLabel(type: string): string {
  return GROUP_TYPE_LABELS[type] ?? (type || "未知类型");
}

/** 下拉一行的说明：类型 · 现用节点（内置组额外标注）。 */
export function groupOptionLabel(group: ProxyGroupInfo): string {
  const parts = [groupTypeLabel(group.type)];
  if (group.now) parts.push(`现用 ${group.now}`);
  if (group.builtin) parts.push("仅全局模式生效");
  return `${group.name}（${parts.join(" · ")}）`;
}

/** 组下拉的候选项：接口读到的组 + 当前填写值兜底（值不在列表里时不至于看不见）。 */
export function groupOptions(groups: ProxyGroupInfo[], current: string): { value: string; label: string }[] {
  const options = groups.map((group) => ({ value: group.name, label: groupOptionLabel(group) }));
  if (current && !groups.some((group) => group.name === current)) {
    options.unshift({ value: current, label: `${current}（当前填写，接口里没读到这个组）` });
  }
  return options;
}

export function findGroup(groups: ProxyGroupInfo[], name: string): ProxyGroupInfo | undefined {
  return groups.find((group) => group.name === name);
}

/** 节点多选候选：信息位不进候选（自动切换时也不会选它们），子组标"分组"。 */
export function nodeOptions(groups: ProxyGroupInfo[], groupName: string): { id: string; note?: string }[] {
  const group = findGroup(groups, groupName);
  if (!group) return [];
  return group.nodes
    .filter((node) => !node.info)
    .map((node) => ({ id: node.name, note: node.group ? "分组" : undefined }));
}

/** 切换范围的存取：面板里是标签数组，库里是逗号分隔的关键词串（中英文逗号都认）。 */
export function filterToTags(text: string): string[] {
  return text
    .split(/[,，]/)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

export function tagsToFilter(tags: string[]): string {
  return tags.join(",");
}
