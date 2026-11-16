import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { AuditPanel } from "@/audit/AuditPanel";
import { auditApi } from "@/shared/api/reports.api";
import type { AuditLogRow } from "@/shared/api/types/ops";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

const rows: AuditLogRow[] = [
  { id: 1, occurred_at: "2026-10-01", actor: "admin", action: "ORDER_CREATE", entity_type: "order", entity_id: "10", reason: null },
];

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(auditApi.list).mockResolvedValue({ items: rows, total: rows.length });
  vi.mocked(auditApi.actions).mockResolvedValue(["ORDER_CREATE"]);
});

describe("AuditPanel：审计记录", () => {
  it("使用公共日期控件，并按字段语义控制筛选宽度", async () => {
    renderLight(<AuditPanel />, { user: "admin" });

    const filterBar = document.querySelector(".audit-filter-bar");
    expect(filterBar).toBeInTheDocument();
    expect(filterBar?.querySelectorAll(".audit-filter-select")).toHaveLength(3);
    expect(document.querySelector(".audit-config-item-select")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("对象编号")).toHaveClass("audit-filter-input");
    expect(screen.getByPlaceholderText("操作人")).toHaveClass("audit-filter-input");
    expect(screen.getByLabelText("审计开始日期").closest(".ant-picker")).toHaveClass("audit-filter-date");
    expect(screen.getByLabelText("审计结束日期").closest(".ant-picker")).toHaveClass("audit-filter-date");
  });

  it("加载并展示审计行", async () => {
    renderLight(<AuditPanel />, { user: "admin" });
    expect(await screen.findByText("admin")).toBeInTheDocument();
    // 动作与对象类型均按中文标签渲染（AUDIT_ACTION_LABEL / ENTITY_TYPE_LABEL）
    expect(screen.getByText("新建订单")).toBeInTheDocument();
    expect(screen.getByText("订单")).toBeInTheDocument();
  });

  it("展示配置项列并支持按配置项筛选", async () => {
    vi.mocked(auditApi.list).mockResolvedValue({
      items: [{ ...rows[0], entity_type: "Pool", action: "POOL_DISABLE" }],
      total: 1,
    });
    vi.mocked(auditApi.actions).mockResolvedValue(["POOL_DISABLE"]);
    renderLight(<AuditPanel />, { user: "admin" });

    expect(await screen.findByText("资金池")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "配置项" })).toBeInTheDocument();

    const configSelect = document.querySelector(".audit-config-item-select .ant-select-selector") as HTMLElement;
    await ui.click(configSelect);
    await ui.click(await screen.findByText("资金池 · 资金池", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(vi.mocked(auditApi.list)).toHaveBeenLastCalledWith(expect.objectContaining({ entity_type: "Pool" })));
  });

  it("配置项筛选中的对象类型使用中文标签", async () => {
    renderLight(<AuditPanel />, { user: "admin" });

    const configSelect = document.querySelector(".audit-config-item-select .ant-select-selector") as HTMLElement;
    await ui.click(configSelect);

    expect(await screen.findByText("资金池 · 资金路由", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    expect(screen.queryByText("资金池 · OrderTypePool", { selector: ".ant-select-item-option-content" })).toBeNull();
  });

  it("加载失败展示错误横幅", async () => {
    vi.mocked(auditApi.list).mockRejectedValue(new Error("audit down"));
    renderLight(<AuditPanel />, { user: "admin" });
    expect(await screen.findByText(/audit down/)).toBeInTheDocument();
  });

  it("按对象编号筛选重新加载", async () => {
    renderLight(<AuditPanel />, { user: "admin" });
    await screen.findByText("admin");
    const before = vi.mocked(auditApi.list).mock.calls.length;
    await ui.type(screen.getByPlaceholderText("对象编号"), "10");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(vi.mocked(auditApi.list).mock.calls.length).toBeGreaterThan(before));
  });

  it("动作字典接口失败时仍保留可读的回落选项", async () => {
    vi.mocked(auditApi.actions).mockRejectedValueOnce(new Error("actions down"));
    renderLight(<AuditPanel />, { user: "admin" });
    await screen.findByText("admin");
    const actionSelect = document.querySelector(".audit-action-select .ant-select-selector") as HTMLElement;
    await ui.click(actionSelect);
    expect(await screen.findByText("新建资金池", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("FE-150：选择对象类型后只查询对应审计记录", async () => {
    const otherRow = { ...rows[0], id: 2, actor: "finance", action: "POOL_DISABLE", entity_type: "Pool", entity_id: "3" } as AuditLogRow;
    vi.mocked(auditApi.list).mockImplementation(async (params) =>
      params?.entity_type === "order"
        ? { items: [rows[0]], total: 1 }
        : { items: [rows[0], otherRow], total: 2 },
    );
    renderLight(<AuditPanel />, { user: "admin" });
    await screen.findByText("finance");
    const entitySelect = document.querySelector(".audit-entity-type-select .ant-select-selector") as HTMLElement;
    await ui.click(entitySelect);
    await ui.click(await screen.findByText("订单", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(vi.mocked(auditApi.list)).toHaveBeenLastCalledWith(expect.objectContaining({ entity_type: "order" })));
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.queryByText("finance")).toBeNull();
  });

  it("FE-151：选择审计动作后只查询对应动作记录", async () => {
    vi.mocked(auditApi.actions).mockResolvedValueOnce(["ORDER_CREATE", "POOL_DISABLE"]);
    const otherRow = { ...rows[0], id: 2, actor: "finance", action: "POOL_DISABLE", entity_type: "Pool", entity_id: "3" } as AuditLogRow;
    vi.mocked(auditApi.list).mockImplementation(async (params) =>
      params?.action === "ORDER_CREATE"
        ? { items: [rows[0]], total: 1 }
        : { items: [rows[0], otherRow], total: 2 },
    );
    renderLight(<AuditPanel />, { user: "admin" });
    await screen.findByText("finance");
    const actionSelect = document.querySelector(".audit-action-select .ant-select-selector") as HTMLElement;
    await ui.click(actionSelect);
    await ui.click(await screen.findByText("新建订单", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(vi.mocked(auditApi.list)).toHaveBeenLastCalledWith(expect.objectContaining({ action: "ORDER_CREATE" })));
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.queryByText("finance")).toBeNull();
  });
});
