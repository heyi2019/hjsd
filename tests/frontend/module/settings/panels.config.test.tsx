/** 配置类只读面板——编号序列与业务提醒。 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
      { sequence_key: "STOCK_NO", prefix: "KU_", padding: 5, current_value: 20, next_number: "KU_00021" },
      { sequence_key: "ORDER_HS", prefix: "HS", padding: 4, current_value: 128, next_number: "HS0129" },
      { sequence_key: "CASHFLOW_OUT", prefix: "ZC", padding: 5, current_value: 7, next_number: "ZC00008" },
    ]);
  });

  it("库存编号显示独立序列值及预计下一编号（只读）", async () => {
    renderLight(<SequencesPanel />, { user: "admin" });

    const stockRow = await screen.findByRole("row", { name: /库存编号/ });
    expect(within(stockRow).getByText(/KU_.*5.*位/)).toBeInTheDocument();
    expect(within(stockRow).getByText("20")).toBeInTheDocument();
    expect(within(stockRow).getByText("KU_00021")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "预计下一编号" })).toBeInTheDocument();
    expect(screen.getByText("HS0129")).toBeInTheDocument();
    expect(screen.getByText("ZC00008")).toBeInTheDocument();
    expect(screen.queryByText(/不参与序列发放/)).toBeNull();
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

  it("分期合约和返点按订单派生，不展示虚构的独立序列", async () => {
    vi.mocked(sequencesApi.list).mockResolvedValue([
      { sequence_key: "INSTALLMENT", prefix: "FQ", padding: 4, current_value: 0, next_number: "FQ0001" },
    ]);
    renderLight(<SequencesPanel />, { user: "admin" });

    expect(await screen.findByText(/HS0001-FQ-02/)).toBeInTheDocument();
    expect(screen.getByText(/HS0001-RB01/)).toBeInTheDocument();
    expect(screen.queryByText("FQ0001")).toBeNull();
  });

  it("业务主数据序列展示真实名称和编码格式，无法识别的配置不猜测编号", async () => {
    vi.mocked(sequencesApi.list).mockResolvedValue([
      {
        sequence_key: "OPTION_3d0b7293e220dff669157b17b6932008", prefix: "D", padding: 2,
        current_value: 3, next_number: "D04", display_label: "包赔类型", display_prefix: "compensation_type_",
      },
      {
        sequence_key: "OPTION_00000000000000000000000000000000", prefix: "D", padding: 2,
        current_value: 1, next_number: "D02", display_label: null, display_prefix: null,
      },
    ]);
    renderLight(<SequencesPanel />, { user: "admin" });

    const knownRow = await screen.findByRole("row", { name: /包赔类型/ });
    expect(within(knownRow).getByText("业务主数据")).toBeInTheDocument();
    expect(within(knownRow).getByText("compensation_type_ + 至少 2 位")).toBeInTheDocument();
    expect(within(knownRow).getByText("compensation_type_04")).toBeInTheDocument();
    expect(within(knownRow).queryByText("D04")).toBeNull();

    const unknownRow = screen.getByRole("row", { name: /OPTION_00000000000000000000000000000000/ });
    expect(within(unknownRow).getByText("业务主数据")).toBeInTheDocument();
    expect(within(unknownRow).getAllByText("无法识别")).toHaveLength(2);
    expect(within(unknownRow).queryByText("D02")).toBeNull();
  });

  it("移除已停用的编号域，同时保留其他未识别的序列", async () => {
    vi.mocked(sequencesApi.list).mockResolvedValue([
      { sequence_key: "ORDER_HS", prefix: "HS", padding: 4, current_value: 128, next_number: "HS0129" },
      { sequence_key: "ORDER_QA5B", prefix: "QA5B", padding: 4, current_value: 0, next_number: "QA5B0001" },
      { sequence_key: "QUALITY_ISSUE", prefix: "QI", padding: 4, current_value: 0, next_number: "QI0001" },
      { sequence_key: "IMPORT", prefix: "IMP", padding: 4, current_value: 0, next_number: "IMP0001" },
      { sequence_key: "ATTACHMENT", prefix: "ATT", padding: 4, current_value: 0, next_number: "ATT0001" },
    ]);
    renderLight(<SequencesPanel />, { user: "admin" });

    const unknownRow = await screen.findByRole("row", { name: /QA5B0001/ });
    expect(within(unknownRow).getByText("其他／待核对")).toBeInTheDocument();
    expect(screen.getAllByText("HS0129")).toHaveLength(1);
    expect(screen.queryByText("QI0001")).toBeNull();
    expect(screen.queryByText("IMP0001")).toBeNull();
    expect(screen.queryByText("ATT0001")).toBeNull();
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
