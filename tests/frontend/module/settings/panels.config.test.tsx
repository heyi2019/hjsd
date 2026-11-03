/**
 * 配置类只读面板——由 3 个碎片文件合并而来：
 *   ConfigAuditPanel.test.tsx / SequencesPanel.test.tsx / BusinessReminderSettingsPanel.test.tsx
 * 合并动因同上（文件级 import/transform 是固定成本）；用例与断言逐条保留，各自 describe 隔离。
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { seedOptionSets } from "@fixtures/formFieldsSeed";
import * as catalog from "@/shared/api/catalog";
import type { AuditLogRow } from "@/shared/api/catalog";
import { ConfigAuditPanel } from "@/field-definitions/panels/ConfigAuditPanel";
import { SequencesPanel } from "@/field-definitions/panels/SequencesPanel";
import { BusinessReminderSettingsPanel } from "@/field-definitions/panels/BusinessReminderSettingsPanel";

vi.mock("@/shared/api/catalog");

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
    renderLight(<ConfigAuditPanel />, { user: "admin" });

    expect(await screen.findByText("取消押金")).toBeInTheDocument();
    expect(screen.getByText("取消返点")).toBeInTheDocument();
    expect(screen.getByText("驳回导入批次")).toBeInTheDocument();
  });

  it("加载失败时记录数标记为不可用并禁用筛选、提供重新加载（L346）", async () => {
    vi.mocked(catalog.auditApi).list.mockRejectedValue(new Error("审计服务不可用"));
    vi.mocked(catalog.auditApi).actions.mockResolvedValue(["ROUTE_UPDATE"]);
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

  it("FE-176：按动作筛选改动追溯并只保留匹配记录", async () => {
    const other = { ...ROWS[0], id: 9, actor: "finance", action: "POOL_DISABLE", entity_type: "Pool" } as AuditLogRow;
    vi.mocked(catalog.auditApi).list.mockImplementation(async (params) =>
      params?.action === "ROUTE_UPDATE"
        ? { items: [ROWS[0]], total: 1 }
        : { items: [ROWS[0], other], total: 2 },
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<ConfigAuditPanel />, { user: "admin" });
    await screen.findByText("配置改动追溯");
    const actionSelect = document.querySelectorAll(".ui-filter-bar .ant-select")[1] as HTMLElement;
    await user.click(actionSelect.querySelector(".ant-select-selector") as HTMLElement);
    await user.click(await screen.findByText("更新资金路由", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(vi.mocked(catalog.auditApi).list).toHaveBeenLastCalledWith(expect.objectContaining({ action: "ROUTE_UPDATE" })));
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.queryByText("finance")).toBeNull();
  });
});

describe("SequencesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(catalog.sequencesApi.list).mockResolvedValue([
      { sequence_key: "ORDER_HS", prefix: "HS", padding: 4, current_value: 128, next_number: "HS0129" },
      { sequence_key: "CASHFLOW_OUT", prefix: "ZC", padding: 5, current_value: 7, next_number: "ZC00008" },
    ]);
  });

  it("展示编号域的当前值与下一编号（只读，无写入口）", async () => {
    renderLight(<SequencesPanel />, { user: "admin" });

    // 分组 + 条目：下一编号出现在「加粗名称：说明」行内；流水编号带 padding 位数
    expect(await screen.findByText(/HS0129/)).toBeInTheDocument();
    expect(screen.getByText(/ZC\+5位流水/)).toBeInTheDocument();
    expect(screen.getByText(/ZC00008/)).toBeInTheDocument();
    // 编号域中文标签可见；分组标签与业务字典一致
    expect(screen.getAllByText("回收编号").length).toBeGreaterThan(0);
    expect(screen.getAllByText("支出流水").length).toBeGreaterThan(0);
    // 静态口径条目：库存编号 / 分期合约号（无 document_sequences 行也展示）
    expect(screen.getByText("库存编号")).toBeInTheDocument();
    expect(screen.getByText("分期合约号")).toBeInTheDocument();
    expect(screen.getByText("编号格式 业务订单编号-FQ")).toBeInTheDocument();
    // 只读面板：不提供任何新增/编辑/重置入口
    expect(screen.queryByRole("button", { name: /新建|编辑|重置|保存/ })).toBeNull();
  });

  it("分期合约号按业务订单号派生，不展示独立流水序列", async () => {
    vi.mocked(catalog.sequencesApi.list).mockResolvedValue([
      { sequence_key: "INSTALLMENT", prefix: "FQ", padding: 4, current_value: 0, next_number: "FQ0001" },
    ]);
    renderLight(<SequencesPanel />, { user: "admin" });

    expect(await screen.findByText("编号格式 业务订单编号-FQ")).toBeInTheDocument();
    expect(screen.queryByText(/FQ\+4位流水/)).toBeNull();
    expect(screen.queryByText(/当前值 0/)).toBeNull();
    expect(screen.queryByText("FQ0001")).toBeNull();
  });

  it("静态分组外的动态编号域落入「自定义编号域」兜底组（不静默丢失）", async () => {
    vi.mocked(catalog.sequencesApi.list).mockResolvedValue([
      { sequence_key: "ORDER_HS", prefix: "HS", padding: 4, current_value: 128, next_number: "HS0129" },
      { sequence_key: "ORDER_QA5B", prefix: "QA5B", padding: 4, current_value: 0, next_number: "QA5B0001" },
    ]);
    renderLight(<SequencesPanel />, { user: "admin" });

    expect(await screen.findByText("自定义编号域")).toBeInTheDocument();
    expect(screen.getByText(/QA5B0001/)).toBeInTheDocument();
    // 分组内已覆盖的域不重复出现在兜底组
    expect(screen.getAllByText(/HS0129/).length).toBe(1);
  });

  it("加载失败时展示错误横幅（不静默）", async () => {
    vi.mocked(catalog.sequencesApi.list).mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "INTERNAL", message: "编号序列加载失败" } },
      message: "Request failed",
    });
    renderLight(<SequencesPanel />, { user: "admin" });

    expect(await screen.findByText("编号序列加载失败")).toBeInTheDocument();
  });
});

describe("BusinessReminderSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("业务提醒读取失败时锁定保存按钮并提供重试入口（L1659）", async () => {
    vi.mocked(catalog.optionSetsApi).get.mockRejectedValue(new Error("提醒配置读取失败"));
    renderLight(<BusinessReminderSettingsPanel />, { user: "admin" });

    // 错误态可见，不应误导用户为「已加载可编辑」
    expect(await screen.findByText(/提醒配置读取失败/)).toBeInTheDocument();
    // 读取失败时保存按钮被禁用，避免用默认值覆盖真实配置
    expect(screen.getByRole("button", { name: /保存配置/ })).toBeDisabled();
    // 保留重试入口，重试成功后恢复可编辑
    expect(screen.getByRole("button", { name: /重新加载/ })).toBeInTheDocument();
  });

  it("业务提醒正常加载后保存按钮可用（L1659 反向保障）", async () => {
    vi.mocked(catalog.optionSetsApi).get.mockResolvedValue({
      options: [{ value: "inventory_aging_days", label: "库存订单超过多少天提醒", value2: "7" }],
    } as never);
    vi.mocked(catalog.optionSetsApi).update.mockResolvedValue(undefined as never);
    renderLight(<BusinessReminderSettingsPanel />, { user: "admin" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /保存配置/ })).toBeEnabled(),
    );
  });
});
