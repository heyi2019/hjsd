/** 配置类只读面板——编号序列与业务提醒。 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { sequencesApi } from "@/shared/api/misc.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { orderFormFieldsApi } from "@/shared/api/orders.api";
import { SequencesPanel } from "@/settings/panels/SequencesPanel";
import { BusinessReminderSettingsPanel } from "@/settings/panels/BusinessReminderSettingsPanel";
import { CompanyProfitSettingsPanel } from "@/settings/panels/CompanyProfitSettingsPanel";
import { profitAllocationApi } from "@/shared/api/profitAllocation.api";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/profitAllocation.api");
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

  it("通知编号接近上限时显示剩余数量和影响", async () => {
    vi.mocked(sequencesApi.list).mockResolvedValue([
      { sequence_key: "NOTIFICATION", prefix: "NTF", padding: 4, current_value: 9900, next_number: "NTF9901", remaining: 99, near_exhaustion: true },
    ]);
    renderLight(<SequencesPanel />, { user: "admin" });
    expect(await screen.findByText(/通知编号还剩 99 个/)).toBeInTheDocument();
    expect(screen.getByText(/用尽后需要生成通知的操作会失败/)).toBeInTheDocument();
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
    let resolveFields!: (value: Awaited<ReturnType<typeof orderFormFieldsApi.list>>) => void;
    vi.mocked(orderFormFieldsApi.list).mockReturnValueOnce(new Promise((resolve) => { resolveFields = resolve; }));
    const consoleError = vi.spyOn(console, "error");
    vi.mocked(optionSetsApi).get.mockRejectedValue(new Error("提醒配置读取失败"));
    const { container } = renderLight(<BusinessReminderSettingsPanel />, { user: "admin" });

    // 错误态可见，不应误导用户为「已加载可编辑」
    expect(await screen.findByText(/提醒配置读取失败/)).toBeInTheDocument();
    expect(container.querySelector("form")).toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("Instance created by `useForm`"));
    consoleError.mockRestore();
    await act(async () => { resolveFields([]); });
    // 读取失败时保存按钮被禁用，避免用默认值覆盖真实配置
    expect(screen.getByRole("button", { name: /保存配置/ })).toBeDisabled();
    // 保留重试入口，重试成功后恢复可编辑
    expect(screen.getByRole("button", { name: /重新加载/ })).toBeInTheDocument();
  });

  it("业务提醒正常加载后保存按钮可用（L1659 反向保障）", async () => {
    vi.mocked(optionSetsApi).get.mockResolvedValue({
      options: [{ value: "inventory_aging_days", label: "7" }, { value: "profit_notifications_enabled", label: "1" }],
    } as never);
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([
      { field_key: "inventoryAgingDays", label: "提醒天数", is_active: true, required: true, field_type: "NUMBER" },
      { field_key: "profitNotificationsEnabled", label: "分润", is_active: false, required: false, field_type: "BOOLEAN" },
    ] as never);
    vi.mocked(optionSetsApi).update.mockResolvedValue(undefined as never);
    renderLight(<BusinessReminderSettingsPanel />, { user: "admin" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /保存配置/ })).toBeEnabled(),
    );
    expect(await screen.findByText("提醒天数")).toBeInTheDocument();
    expect(screen.queryByText("新的分润通知")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /保存配置/ }));
    await waitFor(() => expect(optionSetsApi.update).toHaveBeenCalledWith("BUSINESS_OVERVIEW_REMINDERS", expect.objectContaining({
      options: expect.arrayContaining([{ value: "profit_notifications_enabled", label: "1" }]),
    })));
  });

  it("提醒设置保存与重新读取期间防止重复提交", async () => {
    let finishUpdate!: () => void;
    let finishReload!: (value: Awaited<ReturnType<typeof optionSetsApi.get>>) => void;
    const config = { options: [{ value: "inventory_aging_days", label: "7" }] } as never;
    vi.mocked(optionSetsApi.get).mockResolvedValueOnce(config)
      .mockReturnValueOnce(new Promise((resolve) => { finishReload = resolve; }));
    vi.mocked(optionSetsApi.update).mockReturnValueOnce(new Promise((resolve) => { finishUpdate = () => resolve(undefined as never); }));
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([]);
    renderLight(<BusinessReminderSettingsPanel />, { user: "admin" });
    const button = await screen.findByRole("button", { name: "保存配置" });
    await waitFor(() => expect(button).toBeEnabled());
    const form = button.closest("form")!;
    await act(async () => { fireEvent.submit(form); fireEvent.submit(form); });
    await waitFor(() => expect(optionSetsApi.update).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    await act(async () => finishUpdate());
    await waitFor(() => expect(optionSetsApi.get).toHaveBeenCalledTimes(2));
    expect(button).toBeDisabled();
    await act(async () => { fireEvent.submit(form); });
    expect(optionSetsApi.update).toHaveBeenCalledTimes(1);
    await act(async () => finishReload(config));
    await waitFor(() => expect(button).toBeEnabled());
  });
});

describe("CompanyProfitSettingsPanel", () => {
  it("读取并保存盈利和亏损的公司分润比例", async () => {
    vi.clearAllMocks();
    vi.mocked(profitAllocationApi.companySettings).mockResolvedValue({ profit_rate: "40.00", loss_rate: "50.00" });
    vi.mocked(profitAllocationApi.updateCompanySettings).mockResolvedValue({ profit_rate: "35.00", loss_rate: "45.00" });
    renderLight(<CompanyProfitSettingsPanel />, { user: "admin" });
    const profit = await screen.findByRole("spinbutton", { name: "盈利时公司比例" });
    const loss = screen.getByRole("spinbutton", { name: "亏损时公司比例" });
    await waitFor(() => expect(profit).toHaveValue("40.00"));
    expect(loss).toHaveValue("50.00");
    fireEvent.change(profit, { target: { value: "35" } });
    fireEvent.change(loss, { target: { value: "45" } });
    await act(async () => { fireEvent.submit(profit.closest("form")!); });
    await waitFor(() => expect(profitAllocationApi.updateCompanySettings).toHaveBeenCalledWith({ profit_rate: "35", loss_rate: "45" }));
  });
});
