/** 配置类只读面板——编号序列与业务提醒。 */
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { sequencesApi } from "@/shared/api/misc.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { SequencesPanel } from "@/field-definitions/panels/SequencesPanel";
import { BusinessReminderSettingsPanel } from "@/field-definitions/panels/BusinessReminderSettingsPanel";

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

describe("SequencesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sequencesApi.list).mockResolvedValue([
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
    vi.mocked(sequencesApi.list).mockResolvedValue([
      { sequence_key: "INSTALLMENT", prefix: "FQ", padding: 4, current_value: 0, next_number: "FQ0001" },
    ]);
    renderLight(<SequencesPanel />, { user: "admin" });

    expect(await screen.findByText("编号格式 业务订单编号-FQ")).toBeInTheDocument();
    expect(screen.queryByText(/FQ\+4位流水/)).toBeNull();
    expect(screen.queryByText(/当前值 0/)).toBeNull();
    expect(screen.queryByText("FQ0001")).toBeNull();
  });

  it("静态分组外的动态编号域落入「自定义编号域」兜底组（不静默丢失）", async () => {
    vi.mocked(sequencesApi.list).mockResolvedValue([
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
    vi.mocked(sequencesApi.list).mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "INTERNAL", message: "编号序列加载失败" } },
      message: "Request failed",
    });
    renderLight(<SequencesPanel />, { user: "admin" });

    expect(await screen.findByText("编号序列加载失败")).toBeInTheDocument();
  });

  it("P1/FE-219：编号序列数据失败时不伪装成真实空列表", async () => {
    vi.mocked(sequencesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "sequences down" });
    renderLight(<SequencesPanel />, { user: "admin" });

    expect(await screen.findByText("编号序列数据不可用，请点击重新加载")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重新加载/ })).toBeInTheDocument();
  });
});

describe("BusinessReminderSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("业务提醒读取失败时锁定保存按钮并提供重试入口（L1659）", async () => {
    vi.mocked(optionSetsApi).get.mockRejectedValue(new Error("提醒配置读取失败"));
    renderLight(<BusinessReminderSettingsPanel />, { user: "admin" });

    // 错误态可见，不应误导用户为「已加载可编辑」
    expect(await screen.findByText(/提醒配置读取失败/)).toBeInTheDocument();
    // 读取失败时保存按钮被禁用，避免用默认值覆盖真实配置
    expect(screen.getByRole("button", { name: /保存配置/ })).toBeDisabled();
    // 保留重试入口，重试成功后恢复可编辑
    expect(screen.getByRole("button", { name: /重新加载/ })).toBeInTheDocument();
  });

  it("业务提醒正常加载后保存按钮可用（L1659 反向保障）", async () => {
    vi.mocked(optionSetsApi).get.mockResolvedValue({
      options: [{ value: "inventory_aging_days", label: "库存订单超过多少天提醒", value2: "7" }],
    } as never);
    vi.mocked(optionSetsApi).update.mockResolvedValue(undefined as never);
    renderLight(<BusinessReminderSettingsPanel />, { user: "admin" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /保存配置/ })).toBeEnabled(),
    );
  });
});
