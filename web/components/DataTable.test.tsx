/** DataTable 服务端分页模式的渲染钉子（不引 jsdom，用 renderToStaticMarkup）：
 *  重点是「本页为空但总数 > 0」这种越界页码不能把整只表吞成空态——否则没有分页器可点，
 *  用户手改 URL 到 ?page=999 就卡死在空白页上。 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { DataTable, type DColumn } from "@/components/DataTable";

interface Row {
  id: string;
  name: string;
}

const COLUMNS: DColumn<Row>[] = [
  { title: "编号", dataIndex: "id", width: 80 },
  { title: "名称", dataIndex: "name" },
];

function rowsOf(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: String(index + 1), name: `第${index + 1}行` }));
}

describe("DataTable 服务端分页", () => {
  it("页码越界（本页为空但总数 > 0）仍渲染表格壳与分页器，不被空态吞掉", () => {
    const html = renderToStaticMarkup(
      <DataTable<Row> rowKey="id" columns={COLUMNS} rows={[]} total={120} page={99} pageSize={35} empty="暂无数据" />,
    );
    // 表壳留着并给页内空提示，分页器照常可点（页码被钳到最后一页 4）
    expect(html).toContain("这一页没有内容");
    expect(html).toContain("共");
    expect(html).toContain("120");
    expect(html).toContain("下一页");
    expect(html).not.toContain("暂无数据");
  });

  it("总数确实为 0 时才走空态", () => {
    const html = renderToStaticMarkup(
      <DataTable<Row> rowKey="id" columns={COLUMNS} rows={[]} total={0} page={1} pageSize={35} empty="暂无数据" />,
    );
    expect(html).toContain("暂无数据");
    expect(html).not.toContain("这一页没有内容");
  });

  it("rows 已是当前页：只渲染拿到的行，不再本地切片", () => {
    const html = renderToStaticMarkup(
      <DataTable<Row> rowKey="id" columns={COLUMNS} rows={rowsOf(35)} total={120} page={1} pageSize={35} />,
    );
    expect(html).toContain("第1行");
    expect(html).toContain("第35行");
    expect(html).not.toContain("这一页没有内容");
    // 总条数取受控的 total，而不是已加载的 35 行
    expect(html).toContain("120");
  });

  it("没给 total 时保持旧的本地分页行为（切片 + 本地页码）", () => {
    const html = renderToStaticMarkup(
      <DataTable<Row> rowKey="id" columns={COLUMNS} rows={rowsOf(40)} paginated defaultPageSize={35} />,
    );
    expect(html).toContain("第35行");
    expect(html).not.toContain("第36行");
    expect(html).toContain("共");
  });
});

describe("DataTable 行级跨列（订阅套餐行）", () => {
  const SPAN_COLUMNS: DColumn<Row>[] = [
    { title: "编号", key: "site", dataIndex: "id", width: 80 },
    { title: "名称", key: "name", dataIndex: "name" },
    { title: "输入价", key: "input_price", dataIndex: "id" },
    { title: "输出价", key: "output_price", dataIndex: "id" },
  ];

  it("span 行从 startKey 起合并指定列数，渲染自定义内容；其余行不受影响", () => {
    const rows: Row[] = [
      { id: "1", name: "普通行" },
      { id: "2", name: "订阅行" },
    ];
    const html = renderToStaticMarkup(
      <DataTable<Row>
        rowKey="id"
        columns={SPAN_COLUMNS}
        rows={rows}
        rowSpanOf={(row) =>
          row.id === "2" ? { startKey: "input_price", span: 2, render: () => <span>套餐价 $1.54 · 50U · 1天</span> } : null
        }
      />,
    );
    expect(html).toContain("套餐价 $1.54 · 50U · 1天");
    // 合并单元格的 colSpan 生效
    expect(html).toContain('colSpan="2"');
    // 订阅行不再单独出「输出价」td（被合并）；普通行四列齐全
    const subRow = html.slice(html.indexOf("订阅行"));
    expect(subRow).not.toContain(">2</td>"); // 简单佐证：合并段里没有再出第二格数值
    expect(html).toContain("普通行");
  });

  it("rowSpanOf 返回 null 的行照常逐列渲染", () => {
    const html = renderToStaticMarkup(
      <DataTable<Row>
        rowKey="id"
        columns={SPAN_COLUMNS}
        rows={[{ id: "1", name: "普通行" }]}
        rowSpanOf={() => null}
      />,
    );
    expect(html).not.toContain("colspan");
    expect(html).toContain("普通行");
  });
});
