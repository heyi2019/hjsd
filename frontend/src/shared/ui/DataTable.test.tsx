import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "./DataTable";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

interface Row {
  id: number;
  name: string;
}

const columns = [
  { title: "编号", dataIndex: "id" as const },
  { title: "名称", dataIndex: "name" as const },
];

const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `第${i + 1}行` }));

describe("DataTable：三态一致（加载 / 空 / 有数据）", () => {
  it("loading 时渲染加载态，不渲染表格", () => {
    const { container } = render(
      <DataTable columns={columns} rows={rows} loading page={1} pageSize={10} total={12} onPageChange={() => {}} />,
    );
    expect(container.querySelector(".ui-table-loading")).toBeTruthy();
    expect(container.querySelector(".ant-table")).toBeNull();
  });

  it("空数据渲染空态与自定义文案", () => {
    const { container } = render(
      <DataTable columns={columns} rows={[]} page={1} pageSize={10} total={0} emptyText="暂无订单" onPageChange={() => {}} />,
    );
    expect(screen.getByText("暂无订单")).toBeInTheDocument();
    const headers = [...container.querySelectorAll("th")].map((header) => header.textContent);
    expect(headers).toContain("编号");
    expect(headers).toContain("名称");
  });

  it("空数据未传文案时回落「暂无数据」", () => {
    render(<DataTable columns={columns} rows={[]} page={1} pageSize={10} total={0} onPageChange={() => {}} />);
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
  });

  it("有数据时渲染表格行", () => {
    render(<DataTable columns={columns} rows={rows} page={1} pageSize={20} total={12} onPageChange={() => {}} />);
    expect(screen.getByText("第1行")).toBeInTheDocument();
  });

  it("前端分页尊重调用方 pageSize（初值取 props.pageSize，不再硬编码 10）", () => {
    // 修复前：const [innerSize] = useState(10) 忽略 props.pageSize，传 20 仍只渲染 10 行。
    // 修复后：初值取 props.pageSize ?? 10，rows 共 12 行 < 20 应全渲染。
    const { container } = render(
      <DataTable columns={columns} rows={rows} page={1} pageSize={20} total={12} onPageChange={() => {}} />,
    );
    expect(container.querySelectorAll("tbody tr").length).toBe(12);
    expect(screen.getByText("第11行")).toBeInTheDocument();
  });

  it("前端分页 pageSize=20 时首屏精确渲染 20 行（非硬编码 10）", () => {
    const big: Row[] = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `R${i + 1}` }));
    const { container } = render(
      <DataTable columns={columns} rows={big} page={1} pageSize={20} total={25} onPageChange={() => {}} />,
    );
    expect(container.querySelectorAll("tbody tr").length).toBe(20);
    expect(screen.queryByText("R21")).toBeNull(); // 第 21 行在第 2 页
  });
});

describe("DataTable：两种分页模式", () => {
  it("服务端分页（controlledPaging）翻页回调上报 page/pageSize", async () => {
    const onPageChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows.slice(0, 10)}
        page={1}
        pageSize={10}
        total={12}
        controlledPaging
        onPageChange={onPageChange}
      />,
    );
    const next = document.querySelector(".ant-pagination-next");
    expect(next).toBeTruthy();
    await ui.click(next as Element);
    expect(onPageChange).toHaveBeenCalled();
    expect(onPageChange.mock.calls[0][0]).toBe(2);
  });

  it("前端分页（默认）内部自管翻页，不回调调用方", async () => {
    const onPageChange = vi.fn();
    render(
      <DataTable columns={columns} rows={rows} page={1} pageSize={10} total={12} onPageChange={onPageChange} />,
    );
    // 默认前端分页：第 11 行在第 2 页，翻页后应出现
    const next = document.querySelector(".ant-pagination-next");
    expect(next).toBeTruthy();
    expect(screen.queryByText("第11行")).toBeNull();
    await ui.click(next as Element);
    expect(await screen.findByText("第11行")).toBeInTheDocument();
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("rowKey 缺省取 id；自定义 rowKey 生效", () => {
    const { container } = render(
      <DataTable
        columns={columns}
        rows={[{ id: 7, name: "自定义键" }]}
        page={1}
        pageSize={10}
        total={1}
        rowKey={(row) => `row-${row.id}`}
        onPageChange={() => {}}
      />,
    );
    expect(container.querySelectorAll("tbody tr").length).toBe(1);
    expect(screen.getByText("自定义键")).toBeInTheDocument();
  });
});
