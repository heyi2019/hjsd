import { Form } from "antd";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { useCreateBusinessLookups } from "@/business/create/useCreateBusinessLookups";
import { useOrderDetailEditor } from "@/business/OrderDetailView/editing/use-order-detail-editor";
import { EmployeeSelectControl } from "@/business/ResponsibleEmployeeSelect";
import { api } from "@/shared/api/client";
import { gameTypesApi } from "@/shared/api/misc.api";
import { employeesApi, usersApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { orderFormFieldsApi } from "@/shared/api/orders.api";
import type { Account } from "@/shared/api/types/accounts";
import type { EmployeeOption } from "@/shared/api/types/org";
import { clearOptionSetsCache, useOptionSet } from "@/shared/lib/optionSets";
import { useOrderFormConfig, useOrderFormSectionLabels } from "@/business/configurable-field/context";

const original: EmployeeOption = { id: 1, username: "admin", display_name: "管理员", is_active: true };
const added: EmployeeOption = { id: 2, username: "new-user", display_name: "新员工", is_active: true };
let employees: EmployeeOption[];

function EmployeeSelectors() {
  const lookups = useCreateBusinessLookups();
  const editor = useOrderDetailEditor({
    getExecutionDetail: () => undefined,
    onSaved: () => undefined,
    onRefreshFailed: () => undefined,
  });
  return <>
    <EmployeeSelectControl aria-label="建单操作人" employees={lookups.employees} />
    <output data-testid="建单员工">{lookups.employees.map((item) => item.display_name).join("、")}</output>
    <output data-testid="建单账户">{lookups.pools.map((item) => item.name).join("、")}</output>
    <output data-testid="建单游戏">{lookups.gameTypes.map((item) => item.name).join("、")}</output>
    <output data-testid="资料错误">{lookups.loadError?.message ?? ""}</output>
    <Form form={editor.invEditExtraForm} />
    <button onClick={() => void editor.openEditor({ id: 1, extra_values: {} } as Account)}>编辑订单</button>
    <EmployeeSelectControl aria-label="详情操作人" employees={editor.employees} />
    <output data-testid="详情在职员工">{editor.employees.filter((item) => item.is_active).map((item) => item.display_name).join("、")}</output>
  </>;
}

function DictionaryProbe() {
  const options = useOptionSet("PAYMENT_PLATFORM");
  return <output data-testid="平台选项">{options?.map((item) => item.label).join("、") ?? "加载中"}</output>;
}

function FormConfigProbe() {
  const { config } = useOrderFormConfig("HS");
  const { labels } = useOrderFormSectionLabels("HS");
  return <>
    <output data-testid="字段配置">{config.note?.label ?? ""}</output>
    <output data-testid="板块标题">{labels.EXTRA ?? ""}</output>
  </>;
}

beforeEach(() => {
  employees = [original];
  vi.spyOn(employeesApi, "list").mockImplementation(async () => [...employees]);
  vi.spyOn(poolsApi, "list").mockResolvedValue([]);
  vi.spyOn(gameTypesApi, "list").mockResolvedValue([]);
  vi.spyOn(api, "post").mockImplementation(async () => {
    employees = [...employees, added];
    return { data: added } as never;
  });
  vi.spyOn(api, "patch").mockImplementation(async (_url, payload) => {
    employees = employees.map((employee) => employee.id === added.id
      ? { ...employee, ...payload as Partial<EmployeeOption> }
      : employee);
    return { data: employees[1] } as never;
  });
});

describe("基础资料变更后的选项", () => {
  it("新增资金账户和游戏类型后已打开的建单资料同步更新", async () => {
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await screen.findByText("管理员", { selector: "output" });
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 3, name: "新增账户", code: "NEW", pool_type: "OPERATING", status: "ACTIVE" }]);
    vi.mocked(gameTypesApi.list).mockResolvedValue([{ id: 4, name: "新增游戏", sort_order: 1, is_active: true, is_default: false }]);

    await act(async () => { await poolsApi.create({ name: "新增账户" }); });
    await waitFor(() => expect(screen.getByTestId("建单账户")).toHaveTextContent("新增账户"));
    await act(async () => { await gameTypesApi.create({ name: "新增游戏" }); });
    await waitFor(() => expect(screen.getByTestId("建单游戏")).toHaveTextContent("新增游戏"));
  });

  it("选项字典更新后，已打开页面使用新选项，旧请求不能覆盖新选项", async () => {
    clearOptionSetsCache();
    let resolveOld!: (value: Awaited<ReturnType<typeof optionSetsApi.list>>) => void;
    const oldRequest = new Promise<Awaited<ReturnType<typeof optionSetsApi.list>>>((resolve) => { resolveOld = resolve; });
    const list = vi.spyOn(optionSetsApi, "list").mockReturnValueOnce(oldRequest)
      .mockResolvedValue({ items: [{ code: "PAYMENT_PLATFORM", options: [{ value: "new", label: "新平台" }] }] } as never);
    vi.spyOn(api, "put").mockResolvedValue({ data: {} } as never);
    renderLight(<DictionaryProbe />, { user: "admin" });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    await act(async () => { await optionSetsApi.update("PAYMENT_PLATFORM", { options: [{ value: "new", label: "新平台" }] }); });
    await waitFor(() => expect(screen.getByTestId("平台选项")).toHaveTextContent("新平台"));
    await act(async () => { resolveOld({ items: [{ code: "PAYMENT_PLATFORM", options: [{ value: "old", label: "旧平台" }] }] } as never); });
    expect(screen.getByTestId("平台选项")).toHaveTextContent("新平台");
  });

  it("基础资料变更后旧请求失败，不应覆盖更新成功的状态", async () => {
    let rejectOld!: (error: Error) => void;
    vi.mocked(poolsApi.list).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOld = reject; }))
      .mockResolvedValue([{ id: 3, name: "新增账户", code: "NEW", pool_type: "OPERATING", status: "ACTIVE" }]);
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await waitFor(() => expect(poolsApi.list).toHaveBeenCalledTimes(1));

    await act(async () => { await poolsApi.create({ name: "新增账户" }); });
    await waitFor(() => expect(screen.getByTestId("建单账户")).toHaveTextContent("新增账户"));
    await act(async () => { rejectOld(new Error("旧请求失败")); });
    expect(screen.getByTestId("资料错误")).not.toHaveTextContent("旧请求失败");
  });

  it("字段和板块标题在设置中修改后，预加载的表单无需刷新即可更新", async () => {
    const fields = vi.spyOn(orderFormFieldsApi, "list").mockResolvedValue([{ field_key: "note", label: "旧字段" }] as never);
    const sections = vi.spyOn(orderFormFieldsApi, "listSectionLabels").mockResolvedValue({ EXTRA: "旧板块" });
    vi.spyOn(api, "put").mockResolvedValue({ data: {} } as never);
    renderLight(<FormConfigProbe />, { user: "admin" });
    await screen.findByText("旧字段");
    await screen.findByText("旧板块");
    fields.mockResolvedValue([{ field_key: "note", label: "新字段" }] as never);
    sections.mockResolvedValue({ EXTRA: "新板块" });

    await act(async () => { await orderFormFieldsApi.update(1, { label: "新字段" }); });
    await waitFor(() => expect(screen.getByTestId("字段配置")).toHaveTextContent("新字段"));
    await act(async () => { await orderFormFieldsApi.saveSectionLabels({ order_type_code: "HS", labels: { EXTRA: "新板块" } }); });
    await waitFor(() => expect(screen.getByTestId("板块标题")).toHaveTextContent("新板块"));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("员工变更后的操作人选项", () => {
  it("已打开的建单和订单详情同步新增、改名和停用的员工", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "编辑订单" }));
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(2));

    await act(async () => { await usersApi.create({ username: added.username }); });

    for (const label of ["建单操作人", "详情操作人"]) {
      await user.click(screen.getByRole("combobox", { name: label }));
      const choices = await screen.findAllByText("新员工", { selector: ".ant-select-item-option-content" });
      const choice = choices[choices.length - 1];
      await user.click(choice);
      expect(screen.getByRole("combobox", { name: label }).closest(".ant-select")).toHaveTextContent("新员工");
    }

    await act(async () => { await usersApi.update(added.id, { display_name: "更名员工" }); });
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(6));
    await waitFor(() => {
      expect(screen.getByTestId("建单员工")).toHaveTextContent("更名员工");
      expect(screen.getByTestId("详情在职员工")).toHaveTextContent("更名员工");
    });

    await act(async () => { await usersApi.update(added.id, { is_active: false }); });
    await waitFor(() => {
      expect(screen.getByTestId("建单员工")).not.toHaveTextContent("更名员工");
      expect(screen.getByTestId("详情在职员工")).not.toHaveTextContent("更名员工");
    });
  });

  it("员工新增时，较早发出的旧名单请求不能覆盖新名单", async () => {
    let resolveOld!: (items: EmployeeOption[]) => void;
    vi.mocked(employeesApi.list).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(1));

    await act(async () => { await usersApi.create({ username: added.username }); });
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(2));
    await act(async () => { resolveOld([original]); });
    await user.click(screen.getByRole("combobox", { name: "建单操作人" }));
    expect(await screen.findByText("新员工", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("新增员工失败时不触发名单更新", async () => {
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await screen.findByText("管理员", { selector: "output" });
    vi.mocked(api.post).mockRejectedValueOnce(new Error("保存失败"));

    await act(async () => { await expect(usersApi.create({ username: added.username })).rejects.toThrow("保存失败"); });
    expect(employeesApi.list).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("建单员工")).toHaveTextContent("管理员");
  });
});
