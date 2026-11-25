/** 设置选项字典及业务周期配置。 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { optionSetsApi } from "@/shared/api/options.api";
import { orderFormFieldsApi } from "@/shared/api/orders.api";
import { BusinessPeriodSettingsPanel } from "@/settings/options/BusinessPeriodSettingsPanel";
import { OptionDictionarySection } from "@/settings/options/IntermediaryPlatformSettingsPanel";

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

describe("OptionDictionarySection", () => {
  it("新增选项时只提交名称，由后台分配编码", async () => {
    const addItem = vi.mocked(optionSetsApi.addItem).mockResolvedValue(undefined as never);
    vi.mocked(optionSetsApi.get).mockResolvedValue({ options: [] } as never);
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([]);
    vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
    renderLight(<OptionDictionarySection code="CUSTOMER_SOURCE" title="客户来源" description="字典" />, { user: "admin" });
    const input = await screen.findByPlaceholderText("请输入客户来源");
    await waitFor(() => expect(screen.getByRole("button", { name: "新增客户来源" })).toBeEnabled());
    fireEvent.change(input, { target: { value: "微博" } });
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    await waitFor(() => expect(addItem).toHaveBeenCalledWith("CUSTOMER_SOURCE", "微博"));
  });

  it("编辑名称时保留字典项原有编码", async () => {
    vi.mocked(optionSetsApi.get).mockResolvedValue({
      options: [{ value: "compensation_type_01", label: "首保" }],
    } as never);
    vi.mocked(optionSetsApi.update).mockResolvedValue(undefined as never);
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([]);
    vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
    renderLight(<OptionDictionarySection code="COMPENSATION_TYPE" title="包赔类型" description="字典" />, { user: "admin" });
    await screen.findByText("首保");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const input = screen.getByPlaceholderText("请输入包赔类型");
    fireEvent.change(input, { target: { value: "首年保障" } });
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    await waitFor(() => expect(optionSetsApi.update).toHaveBeenCalledWith("COMPENSATION_TYPE", {
      options: [{ value: "compensation_type_01", label: "首年保障" }],
    }));
  });

  it("字典写入和刷新期间禁止再次提交及其他修改", async () => {
    let finishUpdate!: () => void;
    let finishReload!: (value: Awaited<ReturnType<typeof optionSetsApi.get>>) => void;
    const original = [{ value: "旧选项", label: "旧选项" }];
    vi.mocked(optionSetsApi.get).mockResolvedValueOnce({ options: original } as never)
      .mockReturnValueOnce(new Promise((resolve) => { finishReload = resolve; }));
    vi.mocked(optionSetsApi.addItem).mockReturnValue(new Promise((resolve) => { finishUpdate = () => resolve(undefined as never); }));
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([]);
    vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
    renderLight(<OptionDictionarySection code="TEST_DICT" title="测试字典" description="字典" />, { user: "admin" });
    const input = await screen.findByPlaceholderText("请输入测试字典");
    await screen.findByText("旧选项");
    fireEvent.change(input, { target: { value: "新选项" } });
    const form = input.closest("form")!;
    await act(async () => { fireEvent.submit(form); fireEvent.submit(form); });
    await waitFor(() => expect(optionSetsApi.addItem).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "新增测试字典" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "上移" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除" })).toBeDisabled();
    await act(async () => { fireEvent.submit(form); });
    expect(optionSetsApi.addItem).toHaveBeenCalledTimes(1);
    await act(async () => finishUpdate());
    await waitFor(() => expect(optionSetsApi.get).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "新增测试字典" })).toBeDisabled();
    await act(async () => finishReload({ options: [...original, { value: "新选项", label: "新选项" }] } as never));
    expect(await screen.findByText("新选项")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "新增测试字典" })).toBeEnabled());
  });

  it("读取失败时禁止覆盖字典，重试成功后保留已有选项", async () => {
    let rejectLoad!: (error: Error) => void;
    vi.mocked(optionSetsApi.get).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectLoad = reject; }));
    vi.mocked(orderFormFieldsApi.list).mockResolvedValue([]);
    vi.mocked(orderFormFieldsApi.listSectionLabels).mockResolvedValue({});
    renderLight(<OptionDictionarySection code="TEST_DICT" title="测试字典" description="字典" />, { user: "admin" });
    const input = await screen.findByPlaceholderText("请输入测试字典");
    expect(screen.getByRole("button", { name: "新增测试字典" })).toBeDisabled();
    await act(async () => rejectLoad(new Error("字典读取失败")));
    expect(await screen.findByText(/字典读取失败/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增测试字典" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "新选项" } });
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    expect(optionSetsApi.addItem).not.toHaveBeenCalled();
    vi.mocked(optionSetsApi.get).mockResolvedValue({ options: [{ value: "原选项", label: "原选项" }] } as never);
    vi.mocked(optionSetsApi.addItem).mockResolvedValue(undefined as never);
    fireEvent.click(screen.getByRole("button", { name: /重新加载/ }));
    expect(await screen.findByText("原选项")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "新增测试字典" })).toBeEnabled());
    fireEvent.change(input, { target: { value: "新选项" } });
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    await waitFor(() => expect(optionSetsApi.addItem).toHaveBeenCalledWith("TEST_DICT", "新选项"));
  });
});

describe("BusinessPeriodSettingsPanel", () => {
  it("保存当期设置时显示进度并阻止重复提交", async () => {
    vi.clearAllMocks();
    vi.mocked(optionSetsApi.get).mockResolvedValue({ options: [{ value: "start_day", label: "16" }] } as never);
    vi.mocked(optionSetsApi.update).mockReturnValue(new Promise(() => {}));
    renderLight(<BusinessPeriodSettingsPanel />, { user: "admin" });
    const input = await screen.findByRole("spinbutton", { name: "每月起始日" });
    await waitFor(() => expect(input).toHaveValue("16"));
    const form = input.closest("form")!;
    await act(async () => { fireEvent.submit(form); });
    await waitFor(() => expect(optionSetsApi.update).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.submit(form); });
    expect(screen.getByRole("button", { name: /保存当期设置/ })).toHaveClass("ant-btn-loading");
    expect(optionSetsApi.update).toHaveBeenCalledTimes(1);
  });
  it("保存每月起始日并更新统一周期", async () => {
    vi.mocked(optionSetsApi.get).mockResolvedValue({ options: [{ value: "start_day", label: "16" }] } as never);
    vi.mocked(optionSetsApi.update).mockResolvedValue(undefined as never);
    const changed = vi.fn();
    window.addEventListener("business-period-config-changed", changed);
    renderLight(<BusinessPeriodSettingsPanel />, { user: "admin" });
    const input = await screen.findByRole("spinbutton", { name: "每月起始日" });
    await waitFor(() => expect(input).toHaveValue("16"));
    expect(screen.getByText("每月 16 日开始")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.blur(input);
    expect(await screen.findByText("每月 10 日开始")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存当期设置" }));
    await waitFor(() => expect(optionSetsApi.update).toHaveBeenCalledWith("BUSINESS_PERIOD", { options: [{ value: "start_day", label: "10" }] }));
    expect(changed).toHaveBeenCalled();
    window.removeEventListener("business-period-config-changed", changed);
  });
});
