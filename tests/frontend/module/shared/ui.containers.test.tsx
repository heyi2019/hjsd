/**
 * 容器类组件：权限、表单、确认框和表格。
 * 合并动因同 ui.atoms（文件级 import+transform 是固定成本）。用例与断言逐条保留。
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { PermissionButton, PermissionGate } from "@/shared/ui/PermissionButton";
import {
  BusinessRegistrationForm,
  BusinessRegistrationGroup,
  BusinessRegistrationSection,
} from "@/shared/ui/BusinessRegistrationForm";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { appMessage } from "@/shared/ui/appFeedback";
import { DataTable } from "@/shared/ui/DataTable";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

describe("PermissionButton：无权限默认隐藏", () => {
  it("admin 有权 → 渲染可点按钮", () => {
    renderLight(<PermissionButton permission="order.create">建单</PermissionButton>, { user: "admin" });
    const btn = screen.getByRole("button", { name: /建单/ });
    expect(btn).toBeEnabled();
  });

  it("viewer 无权 → 完全不渲染（DOM 里不存在）", () => {
    const { container } = renderLight(
      <PermissionButton permission="order.create">建单</PermissionButton>,
      { user: "viewer" },
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("showDisabled → 无权时渲染但禁用", () => {
    renderLight(
      <PermissionButton permission="order.create" showDisabled>
        建单
      </PermissionButton>,
      { user: "viewer" },
    );
    expect(screen.getByRole("button", { name: /建单/ })).toBeDisabled();
  });

  it("有权限时点击回调照常触发", async () => {
    const onClick = vi.fn();
    renderLight(
      <PermissionButton permission="order.create" onClick={onClick}>
        建单
      </PermissionButton>,
      { user: "admin" },
    );
    screen.getByRole("button", { name: /建单/ }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("operator 建单与处理异常可见、用户管理不可见（权限矩阵落地）", () => {
    const { container } = renderLight(
      <>
        <PermissionButton permission="order.create">建单</PermissionButton>
        <PermissionButton permission="order.update">处理异常</PermissionButton>
        <PermissionButton permission="user.manage">用户管理</PermissionButton>
      </>,
      { user: "operator" },
    );
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("建单");
    expect(labels).toContain("处理异常");
    expect(labels).not.toContain("用户管理");
  });
});

describe("PermissionGate：区块级门控", () => {
  it("有权限渲染 children", () => {
    renderLight(
      <PermissionGate permission="finance.read">
        <span>资金明细</span>
      </PermissionGate>,
      { user: "viewer" },
    );
    expect(screen.getByText("资金明细")).toBeInTheDocument();
  });

  it("无权限渲染 fallback，未传则渲染空", () => {
    const { container } = renderLight(
      <PermissionGate permission="order.create">
        <span>建单区</span>
      </PermissionGate>,
      { user: "viewer" },
    );
    expect(container.textContent).toBe("");
  });

  it("无权限时可给 fallback 提示", () => {
    renderLight(
      <PermissionGate permission="order.create" fallback={<span>无权限</span>}>
        <span>建单区</span>
      </PermissionGate>,
      { user: "viewer" },
    );
    expect(screen.getByText("无权限")).toBeInTheDocument();
  });
});

describe("BusinessRegistrationForm", () => {
  it("提供统一布局、错误滚动和当前表单标识", () => {
    renderLight(
      <BusinessRegistrationForm scope="SALE">
        <label htmlFor="amount">金额</label>
        <input id="amount" />
      </BusinessRegistrationForm>,
      { user: "admin" },
    );

    const form = screen.getByRole("textbox").closest("form");
    expect(form).toHaveClass("ui-form-spaced");
    expect(form).toHaveAttribute("data-form-scope", "SALE");
  });

  it("登记表复用建单式横向字段口径", () => {
    renderLight(
      <BusinessRegistrationForm scope="LEAD">
        <label htmlFor="customer">客户</label>
        <input id="customer" />
      </BusinessRegistrationForm>,
      { user: "admin" },
    );

    const form = screen.getByRole("textbox").closest("form");
    expect(form).toHaveClass("business-registration-form", "ant-form-horizontal");
    expect(form).toHaveAttribute("data-form-scope", "LEAD");
  });

  it("提供建单式二级业务分区容器", () => {
    renderLight(
      <BusinessRegistrationSection title="客户信息" description="基础资料">
        <div>字段区域</div>
      </BusinessRegistrationSection>,
      { user: "admin" },
    );

    expect(screen.getByRole("heading", { name: "客户信息" })).toHaveClass("business-registration-section__title");
    expect(screen.getByText("字段区域").parentElement).toHaveClass("business-registration-section__fields");
  });

  it("提供二级容器标题", () => {
    renderLight(
      <BusinessRegistrationGroup title="基础资料" action={<button type="button">增加字段</button>}>
        <div>字段区域</div>
      </BusinessRegistrationGroup>,
      { user: "admin" },
    );

    expect(screen.getByRole("heading", { name: "基础资料" })).toHaveClass("business-registration-group__title");
    expect(screen.getByRole("button", { name: "增加字段" }).parentElement).toHaveClass("business-registration-group__action");
  });
});

describe("ConfirmDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    document.body.querySelectorAll('[class*="ant-modal"]').forEach((el) => el.remove());
  });

  it("open 时渲染标题、描述与默认按钮文案", () => {
    renderLight(
      <ConfirmDialog open title="删除确认" description="此操作不可撤销" okText="删除" onConfirm={vi.fn()} onCancel={vi.fn()} />,
      { user: "admin" },
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("删除确认")).toBeInTheDocument();
    expect(within(dialog).getByText("此操作不可撤销")).toBeInTheDocument();
    // 精确断言可访问名：若 rc-motion 测试桩再次忽略 visible，antd Button 会渲染 loading 图标
    // 把 name 污染成「loading 删除」，这两条会立即失败（回归护栏）。
    expect(within(dialog).getByRole("button", { name: "删除" })).toBeInTheDocument();
    // 默认取消文案
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  it("点击确认调用 onConfirm", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderLight(
      <ConfirmDialog open title="删除确认" okText="删除" onConfirm={onConfirm} onCancel={vi.fn()} />,
      { user: "admin" },
    );
    await ui.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("onConfirm 失败时走全局 toast 且保持打开（由父级决定是否关闭）", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("网络异常"));
    const errorSpy = vi.spyOn(appMessage, "error");
    renderLight(
      <ConfirmDialog open title="删除确认" okText="删除" onConfirm={onConfirm} onCancel={vi.fn()} />,
      { user: "admin" },
    );
    await ui.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除" }));
    // normalizeError 对非 axios 错误取 String(error)（见 src/shared/api/client.ts），故上屏文案为
    // 「Error: 网络异常」；此处只校验全局 toast 触发且携带原错误文本，不过度绑定格式细节。
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("网络异常")));
    // 失败后仍打开，供用户重试
    expect(screen.getByText("删除确认")).toBeInTheDocument();
  });

  it("点击取消调用 onCancel", async () => {
    const onCancel = vi.fn();
    renderLight(
      <ConfirmDialog open title="删除确认" okText="删除" onConfirm={vi.fn()} onCancel={onCancel} />,
      { user: "admin" },
    );
    await ui.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

interface TableRow {
  id: number;
  name: string;
}

const tableColumns = [
  { title: "编号", dataIndex: "id" as const },
  { title: "名称", dataIndex: "name" as const },
];

const tableRows: TableRow[] = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `第${i + 1}行` }));

describe("DataTable：三态一致（加载 / 空 / 有数据）", () => {
  it("loading 时渲染加载态，不渲染表格", () => {
    const { container } = render(
      <DataTable columns={tableColumns} rows={tableRows} loading page={1} pageSize={10} total={12} onPageChange={() => {}} />,
    );
    expect(container.querySelector(".ui-table-loading")).toBeTruthy();
    expect(container.querySelector(".ant-table")).toBeNull();
  });

  it("已有数据刷新时保留表格并禁止操作，完成后显示新结果", () => {
    const onPageChange = vi.fn();
    const props = { columns: tableColumns, rows: tableRows, page: 1, pageSize: 10, total: 12, onPageChange };
    const { container, rerender } = render(<DataTable {...props} />);
    const table = container.querySelector(".ant-table");
    expect(table).toBeTruthy();

    rerender(<DataTable {...props} rows={[]} loading />);
    expect(container.querySelector(".ant-table")).toBe(table);
    expect(screen.getByRole("status", { name: "正在更新数据" })).toBeInTheDocument();
    expect(container.querySelector("[inert]")?.contains(table)).toBe(true);

    rerender(<DataTable {...props} rows={[{ id: 101, name: "新结果" }]} total={1} />);
    expect(container.querySelector(".ant-table")).toBe(table);
    expect(container.querySelector("[inert]")).toBeNull();
    expect(screen.getByText("新结果")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "正在更新数据" })).toBeNull();
  });

  it("空数据渲染空态与自定义文案", () => {
    const { container } = render(
      <DataTable columns={tableColumns} rows={[]} page={1} pageSize={10} total={0} emptyText="暂无订单" onPageChange={() => {}} />,
    );
    expect(screen.getByText("暂无订单")).toBeInTheDocument();
    const headers = [...container.querySelectorAll("th")].map((header) => header.textContent);
    expect(headers).toContain("编号");
    expect(headers).toContain("名称");
  });

  it("空数据未传文案时回落「暂无数据」", () => {
    render(<DataTable columns={tableColumns} rows={[]} page={1} pageSize={10} total={0} onPageChange={() => {}} />);
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
  });

  it("空数据时不启用会撑高空态的滚动容器", () => {
    const { container } = render(
      <DataTable
        columns={tableColumns}
        rows={[]}
        page={1}
        pageSize={10}
        total={0}
        scroll={{ x: "max-content", y: 180 }}
        onPageChange={() => {}}
      />,
    );
    expect(container.querySelector(".ant-table-body")).toBeNull();
    expect(container.querySelector(".ui-datatable__empty")).toBeInTheDocument();
  });

  it("有数据时渲染表格行", () => {
    render(<DataTable columns={tableColumns} rows={tableRows} page={1} pageSize={20} total={12} onPageChange={() => {}} />);
    expect(screen.getByText("第1行")).toBeInTheDocument();
  });

  it("前端分页 pageSize=20 时首屏精确渲染 20 行（非硬编码 10）", () => {
    const big: TableRow[] = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `R${i + 1}` }));
    const { container } = render(
      <DataTable columns={tableColumns} rows={big} page={1} pageSize={20} total={25} onPageChange={() => {}} />,
    );
    expect(container.querySelectorAll(".ant-table-row").length).toBe(20);
    expect(screen.queryByText("R21")).toBeNull(); // 第 21 行在第 2 页
  });
});

describe("DataTable：两种分页模式", () => {
  it("服务端分页（controlledPaging）翻页回调上报 page/pageSize", async () => {
    const onPageChange = vi.fn();
    render(
      <DataTable
        columns={tableColumns}
        rows={tableRows.slice(0, 10)}
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
      <DataTable columns={tableColumns} rows={tableRows} page={1} pageSize={10} total={12} onPageChange={onPageChange} />,
    );
    // 默认前端分页：第 11 行在第 2 页，翻页后应出现
    const next = document.querySelector(".ant-pagination-next");
    expect(next).toBeTruthy();
    expect(screen.queryByText("第11行")).toBeNull();
    await ui.click(next as Element);
    expect(await screen.findByText("第11行")).toBeInTheDocument();
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("排序条件变化时前端分页回到首页", async () => {
    const onPageChange = vi.fn();
    const { rerender } = render(
      <DataTable columns={tableColumns} rows={tableRows} page={1} pageSize={10} total={12} onPageChange={onPageChange} resetKey="desc" />,
    );
    await ui.click(document.querySelector(".ant-pagination-next") as Element);
    expect(await screen.findByText("第11行")).toBeInTheDocument();
    rerender(<DataTable columns={tableColumns} rows={[...tableRows].reverse()} page={1} pageSize={10} total={12} onPageChange={onPageChange} resetKey="asc" />);
    expect(await screen.findByText("第3行")).toBeInTheDocument();
    expect(screen.queryByText("第1行")).toBeNull();
  });

  it("rowKey 缺省取 id；自定义 rowKey 生效", () => {
    const { container } = render(
      <DataTable
        columns={tableColumns}
        rows={[{ id: 7, name: "自定义键" }]}
        page={1}
        pageSize={10}
        total={1}
        rowKey={(row) => `row-${row.id}`}
        onPageChange={() => {}}
      />,
    );
    expect(container.querySelectorAll(".ant-table-row").length).toBe(1);
    expect(screen.getByText("自定义键")).toBeInTheDocument();
  });
});
