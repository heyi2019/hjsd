/** 共享容器的权限、提交、错误处置与分页契约。 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { FormDrawer } from "@/shared/ui/FormDrawer";
import { PermissionButton, PermissionGate } from "@/shared/ui/PermissionButton";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { appMessage } from "@/shared/ui/appFeedback";
import { DataTable } from "@/shared/ui/DataTable";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

const drawerFields = [
  { name: "amount", label: "金额", required: true, kind: "money" as const },
  { name: "note", label: "备注", kind: "textarea" as const, initialValue: "初始备注" },
];

describe("FormDrawer：金额动作必须走抽屉提交", () => {
  it("关闭态不渲染内容", () => {
    const { container } = renderLight(
      <FormDrawer open={false} title="收款" fields={drawerFields} onClose={() => {}} onSubmit={() => {}} />,
    );
    expect(container.querySelector(".ant-drawer-content")).toBeNull();
  });

  it("打开后渲染字段与初始值", async () => {
    renderLight(<FormDrawer open title="收款" fields={drawerFields} onClose={() => {}} onSubmit={() => {}} />);
    expect(await screen.findByText("收款")).toBeInTheDocument();
    expect(screen.getByLabelText("金额")).toBeInTheDocument();
    const note = screen.getByLabelText("备注") as HTMLTextAreaElement;
    expect(note.value).toBe("初始备注");
  });

  it("必填未填时校验拦截，不触发提交", async () => {
    const onSubmit = vi.fn();
    renderLight(<FormDrawer open title="收款" fields={drawerFields} onClose={() => {}} onSubmit={onSubmit} />);
    await ui.click(await screen.findByRole("button", { name: /提交/ }));
    await waitFor(() => expect(screen.getByText("请输入金额")).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("填写后提交，金额以字符串回传（不做 Number 转换）", async () => {
    const onSubmit = vi.fn();
    renderLight(<FormDrawer open title="收款" fields={drawerFields} onClose={() => {}} onSubmit={onSubmit} />);
    await screen.findByText("收款");
    await ui.type(screen.getByLabelText("金额"), "1234.56");
    await ui.click(screen.getByRole("button", { name: /提交/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: "1234.56", note: "初始备注" });
    expect(typeof (onSubmit.mock.calls[0][0] as Record<string, unknown>).amount).toBe("string");
  });

  it("取消按钮触发 onClose", async () => {
    const onClose = vi.fn();
    renderLight(<FormDrawer open title="收款" fields={drawerFields} onClose={onClose} onSubmit={() => {}} />);
    await ui.click(await screen.findByRole("button", { name: /取消/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("submitting 时提交按钮进入 loading，文案可自定义", async () => {
    renderLight(
      <FormDrawer
        open
        title="收款"
        fields={drawerFields}
        submitting
        submitText="确认登记"
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    const btn = await screen.findByRole("button", { name: /确认登记/ });
    expect(btn.classList.contains("ant-btn-loading")).toBe(true);
  });

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

  it("空数据渲染空态与自定义文案", () => {
    const { container } = render(
      <DataTable columns={tableColumns} rows={[]} page={1} pageSize={10} total={0} emptyText="暂无订单" onPageChange={() => {}} />,
    );
    expect(screen.getByText("暂无订单")).toBeInTheDocument();
    const headers = [...container.querySelectorAll("th")].map((header) => header.textContent);
    expect(headers).toContain("编号");
    expect(headers).toContain("名称");
  });

  it("有数据时渲染表格行", () => {
    render(<DataTable columns={tableColumns} rows={tableRows} page={1} pageSize={20} total={12} onPageChange={() => {}} />);
    expect(screen.getByText("第1行")).toBeInTheDocument();
  });

  it("分页控件使用中文标签，避免读屏暴露英文 Page Size", () => {
    render(<DataTable columns={tableColumns} rows={tableRows} page={1} pageSize={10} total={12} onPageChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "每页条数" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页" })).toBeInTheDocument();
  });

  it("展开列有明确的无障碍表头", () => {
    render(
      <DataTable
        columns={tableColumns}
        rows={tableRows.slice(0, 1)}
        page={1}
        pageSize={10}
        total={1}
        onPageChange={() => {}}
        expandable={{ expandedRowRender: () => <div>详情</div> }}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "展开详情" })).toBeInTheDocument();
  });

  it("前端分页尊重调用方 pageSize（初值取 props.pageSize，不再硬编码 10）", () => {
    // 修复前：const [innerSize] = useState(10) 忽略 props.pageSize，传 20 仍只渲染 10 行。
    // 修复后：初值取 props.pageSize ?? 10，rows 共 12 行 < 20 应全渲染。
    const { container } = render(
      <DataTable columns={tableColumns} rows={tableRows} page={1} pageSize={20} total={12} onPageChange={() => {}} />,
    );
    expect(container.querySelectorAll(".ant-table-row").length).toBe(12);
    expect(screen.getByText("第11行")).toBeInTheDocument();
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

});
