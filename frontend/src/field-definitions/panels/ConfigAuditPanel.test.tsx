import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";
import { seedOptionSets } from "../../test/formFieldsSeed";

import * as catalog from "../../shared/api/catalog";
import type { AuditLogRow } from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");

const ROWS = [
  {
    id: 1,
    actor: "admin",
    action: "ROUTE_UPDATE",
    entity_type: "OrderTypePool",
    entity_id: "11",
    reason: "调整代挂总额去向",
    occurred_at: "2026-10-26T13:00:00",
  },
  {
    id: 2,
    actor: "finance",
    action: "POOL_DISABLE",
    entity_type: "Pool",
    entity_id: "3",
    reason: null,
    occurred_at: "2026-10-20T09:30:00",
  },
] as unknown as AuditLogRow[];

describe("ConfigAuditPanel 配置改动追溯页", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedOptionSets(catalog);
    vi.mocked(catalog.auditApi).list.mockResolvedValue({ items: ROWS, total: ROWS.length });
    vi.mocked(catalog.auditApi).actions.mockResolvedValue(["ROUTE_UPDATE", "POOL_DISABLE"]);
  });

  it("把 entity_type 翻成配置项名与对象类型，动作走审计动作中文表", async () => {
    const { ConfigAuditPanel } = await import("./ConfigAuditPanel");
    renderLight(<ConfigAuditPanel />, { user: "admin" });

    expect(await screen.findByText("配置改动追溯")).toBeInTheDocument();
    // 配置项名来自 configCatalog 的 ENTITY_TYPE_TO_ITEM（4cd136c 后 OrderTypePool 归「资金池」项）；
    // 对象类型列来自 ENTITY_TYPE 词典（「资金路由」）。两列各命中一次。
    expect(screen.getAllByText("资金池").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("资金路由").length).toBeGreaterThanOrEqual(1);
    // 对象类型已翻成中文，不再显示裸码
    expect(screen.queryByText("OrderTypePool")).not.toBeInTheDocument();
    // 动作中文名来自 AUDIT_ACTION_LABEL
    expect(screen.getByText("更新资金路由")).toBeInTheDocument();
    expect(screen.getByText("停用资金池")).toBeInTheDocument();
    // 备注为空回落占位，不显示空白
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("筛选条件变化会带上对应参数重新查询", async () => {
    const { ConfigAuditPanel } = await import("./ConfigAuditPanel");
    renderLight(<ConfigAuditPanel />, { user: "admin" });
    await screen.findByText("配置改动追溯");

    await waitFor(() =>
      expect(vi.mocked(catalog.auditApi).list).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 })),
    );
    // 初始不传任何筛选
    expect(vi.mocked(catalog.auditApi).list).not.toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: expect.any(String) }),
    );
  });

  it("只读：页面不提供任何写入口", async () => {
    const { ConfigAuditPanel } = await import("./ConfigAuditPanel");
    renderLight(<ConfigAuditPanel />, { user: "admin" });
    await screen.findByText("配置改动追溯");

    expect(screen.queryByRole("button", { name: /保存|新建|删除|提交/ })).toBeNull();
    expect(screen.getByText("只读")).toBeInTheDocument();
  });

  it("展示新增审计动作的中文名称", async () => {
    vi.mocked(catalog.auditApi).list.mockResolvedValue({
      items: [
        { ...ROWS[0], id: 3, action: "DEPOSIT_CANCEL" },
        { ...ROWS[0], id: 4, action: "REBATE_VOID" },
        { ...ROWS[0], id: 5, action: "IMPORT_REJECT" },
      ],
      total: 3,
    });
    vi.mocked(catalog.auditApi).actions.mockResolvedValue(["DEPOSIT_CANCEL", "REBATE_VOID", "IMPORT_REJECT"]);
    const { ConfigAuditPanel } = await import("./ConfigAuditPanel");
    renderLight(<ConfigAuditPanel />, { user: "admin" });

    expect(await screen.findByText("取消押金")).toBeInTheDocument();
    expect(screen.getByText("作废返点")).toBeInTheDocument();
    expect(screen.getByText("驳回导入批次")).toBeInTheDocument();
  });

  it("加载失败时记录数标记为不可用并禁用筛选、提供重新加载（L346）", async () => {
    vi.mocked(catalog.auditApi).list.mockRejectedValue(new Error("审计服务不可用"));
    vi.mocked(catalog.auditApi).actions.mockResolvedValue(["ROUTE_UPDATE"]);
    const { ConfigAuditPanel } = await import("./ConfigAuditPanel");
    const { container } = renderLight(<ConfigAuditPanel />, { user: "admin" });

    // 失败态不再以“共 0 条”误导，记录数标记为不可用
    expect(await screen.findByText(/记录加载失败，当前记录数不可用/)).toBeInTheDocument();
    expect(screen.queryByText(/当前筛选下共 0 条/)).not.toBeInTheDocument();
    // 仍提供重新加载入口
    expect(screen.getByRole("button", { name: /重新加载/ })).toBeInTheDocument();
    // 筛选控件在失败态被禁用，避免基于损坏状态构建查询
    const selects = container.querySelectorAll(".ant-select");
    expect(selects).toHaveLength(2);
    selects.forEach((select) => expect(select).toHaveClass("ant-select-disabled"));
    expect(container.querySelector(".ant-picker")).toHaveClass("ant-picker-disabled");
    expect(container.querySelector(".ant-input")).toHaveClass("ant-input-disabled");
  });
});
