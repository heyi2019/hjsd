import { Form } from "antd";
import { useState } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { useCreateBusinessLookups } from "@/business/shared/order-create/create/useCreateBusinessLookups";
import { useOrderDetailEditor } from "@/business/shared/order-detail/editing/use-order-detail-editor";
import { EmployeeSelectControl } from "@/shared/forms/ResponsibleEmployeeSelect";
import { api } from "@/shared/api/client";
import { gameTypesApi } from "@/shared/api/misc.api";
import { employeesApi, teamsApi, usersApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { orderFormFieldsApi } from "@/shared/api/orders.api";
import type { Account } from "@/shared/api/types/accounts";
import type { EmployeeOption } from "@/shared/api/types/org";
import { clearOptionSetsCache, useOptionSet } from "@/shared/lib/optionSets";
import { useOrderFormConfig, useOrderFormSectionLabels } from "@/shared/forms/configurable-field/context";
import { UsersPanel } from "@/users/UsersPanel";
import { TeamsPanel } from "@/users/TeamsPanel";

const original: EmployeeOption = { id: 1, username: "admin", display_name: "管理员", is_active: true };
const added: EmployeeOption = { id: 2, username: "new-user", display_name: "新员工", is_active: true };
let employees: EmployeeOption[];

function EmployeeSelectors() {
  const [createOpen, setCreateOpen] = useState(false);
  const lookups = useCreateBusinessLookups(createOpen);
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
    <button onClick={() => setCreateOpen(true)}>打开建单</button>
    <Form form={editor.invEditExtraForm} />
    <button onClick={() => void editor.openEditor({ id: 1, extra_values: {} } as Account)}>编辑订单</button>
    <button onClick={editor.cancelInlineEdit}>关闭编辑</button>
    <output data-testid="编辑状态">{editor.inlineEditId ?? "未编辑"}</output>
    <EmployeeSelectControl aria-label="详情操作人" employees={editor.employees} />
    <output data-testid="详情在职员工">{editor.employees.filter((item) => item.is_active).map((item) => item.display_name).join("、")}</output>
    <output data-testid="详情账户">{editor.pools.map((item) => item.name).join("、")}</output>
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
  it("打开建单时更新其他设备修改的资金账户和游戏类型", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 1, name: "旧账户", code: "OLD", pool_type: "OPERATING", status: "ACTIVE" }]);
    vi.mocked(gameTypesApi.list).mockResolvedValue([{ id: 1, name: "旧游戏", sort_order: 1, is_active: true, is_default: false }]);
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await waitFor(() => expect(screen.getByTestId("建单账户")).toHaveTextContent("旧账户"));
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 3, name: "新增账户", code: "NEW", pool_type: "OPERATING", status: "ACTIVE" }]);
    vi.mocked(gameTypesApi.list).mockResolvedValue([{ id: 4, name: "新增游戏", sort_order: 1, is_active: true, is_default: false }]);

    await user.click(screen.getByRole("button", { name: "打开建单" }));
    await waitFor(() => expect(screen.getByTestId("建单账户")).toHaveTextContent("新增账户"));
    expect(screen.getByTestId("建单游戏")).toHaveTextContent("新增游戏");
    expect(poolsApi.list).toHaveBeenCalledWith({ fresh: true });
    expect(gameTypesApi.list).toHaveBeenCalledWith({ include_inactive: false }, { fresh: true });
  });

  it("新增资金账户和游戏类型后已打开的建单资料同步更新", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 1, name: "旧账户", code: "OLD", pool_type: "OPERATING", status: "ACTIVE" }]);
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await screen.findByText("管理员", { selector: "output" });
    await user.click(screen.getByRole("button", { name: "编辑订单" }));
    await waitFor(() => expect(screen.getByTestId("详情账户")).toHaveTextContent("旧账户"));
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 3, name: "新增账户", code: "NEW", pool_type: "OPERATING", status: "ACTIVE" }]);
    vi.mocked(gameTypesApi.list).mockResolvedValue([{ id: 4, name: "新增游戏", sort_order: 1, is_active: true, is_default: false }]);

    await act(async () => { await poolsApi.create({ name: "新增账户" }); });
    await waitFor(() => expect(screen.getByTestId("建单账户")).toHaveTextContent("新增账户"));
    await waitFor(() => expect(screen.getByTestId("详情账户")).toHaveTextContent("新增账户"));
    await act(async () => { await gameTypesApi.create({ name: "新增游戏" }); });
    await waitFor(() => expect(screen.getByTestId("建单游戏")).toHaveTextContent("新增游戏"));
  });

  it("新增团队后用户管理的团队选项更新，迟到的旧请求不会覆盖新结果", async () => {
    let resolveOld!: (items: Awaited<ReturnType<typeof usersApi.list>>) => void;
    const userList = vi.spyOn(usersApi, "list").mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue([]);
    let teams: Awaited<ReturnType<typeof teamsApi.list>> = [];
    const teamList = vi.spyOn(teamsApi, "list").mockImplementation(async () => [...teams]);
    vi.spyOn(optionSetsApi, "list").mockResolvedValue({ items: [] } as never);
    vi.mocked(api.post).mockImplementation(async () => {
      teams = [{ id: 2, code: "T2", name: "新团队", is_active: true }];
      return { data: teams[0] } as never;
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<UsersPanel />, { user: "admin" });
    await waitFor(() => expect(teamList).toHaveBeenCalledTimes(1));

    await act(async () => { await teamsApi.create({ code: "T2", name: "新团队" }); });
    await waitFor(() => expect(userList).toHaveBeenCalledTimes(2));
    await act(async () => { resolveOld([]); });
    await user.click(screen.getByRole("combobox", { name: "所属团队" }));
    expect(await screen.findByText("新团队", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("用户管理打开团队和账户选择时读取其他设备的最新资料", async () => {
    vi.spyOn(usersApi, "list").mockResolvedValue([]);
    let teams: Awaited<ReturnType<typeof teamsApi.list>> = [];
    vi.spyOn(teamsApi, "list").mockImplementation(async () => [...teams]);
    vi.spyOn(optionSetsApi, "list").mockResolvedValue({ items: [] } as never);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<UsersPanel />, { user: "admin" });
    await screen.findByText("暂无用户");
    teams = [{ id: 2, code: "T2", name: "新团队", is_active: true }];
    vi.mocked(poolsApi.list).mockResolvedValue([{ id: 3, name: "新增账户", code: "NEW", pool_type: "OPERATING", status: "ACTIVE" }]);

    await user.click(screen.getByRole("combobox", { name: "所属团队" }));
    expect(await screen.findByText("新团队", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("combobox", { name: "可见资金账户" }));
    expect(await screen.findByText("新增账户", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    expect(teamsApi.list).toHaveBeenCalledWith({ fresh: true });
    expect(poolsApi.list).toHaveBeenCalledWith({ fresh: true });
  });

  it("另一个标签页修改员工后，当前页面自动更新操作人选项", async () => {
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await screen.findByText("管理员", { selector: "output" });
    employees = [original, added];
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "hj.reference-data-changed",
        newValue: JSON.stringify({ resource: "employees", id: "other-tab" }),
      }));
    });
    await waitFor(() => expect(screen.getByTestId("建单员工")).toHaveTextContent("新员工"));
  });

  it("另一个标签页新增员工后，用户管理列表也自动更新", async () => {
    let users: Awaited<ReturnType<typeof usersApi.list>> = [];
    vi.spyOn(usersApi, "list").mockImplementation(async () => [...users]);
    vi.spyOn(teamsApi, "list").mockResolvedValue([]);
    vi.spyOn(optionSetsApi, "list").mockResolvedValue({ items: [] } as never);
    renderLight(<UsersPanel />, { user: "admin" });
    await screen.findByText("暂无用户");
    users = [{ ...added, role: "VIEWER", owner_scope: "SELF", pool_ids: [], team_ids: [], must_change_password: false }];

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "hj.reference-data-changed",
        newValue: JSON.stringify({ resource: "employees", id: "other-tab" }),
      }));
    });
    expect(await screen.findByText("new-user")).toBeInTheDocument();
  });

  it("另一个标签页新增团队后，团队管理列表自动更新", async () => {
    let teams: Awaited<ReturnType<typeof teamsApi.list>> = [];
    vi.spyOn(teamsApi, "list").mockImplementation(async () => [...teams]);
    renderLight(<TeamsPanel />, { user: "admin" });
    await screen.findByText("暂无团队");
    teams = [{ id: 2, code: "T2", name: "新团队", is_active: true }];

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "hj.reference-data-changed",
        newValue: JSON.stringify({ resource: "teams", id: "other-tab" }),
      }));
    });
    expect(await screen.findByText("新团队")).toBeInTheDocument();
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
  it("其他设备新增员工后，打开操作人下拉即可取得最新名单", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await screen.findByText("管理员", { selector: "output" });
    employees = [original, added];

    await user.click(screen.getByRole("combobox", { name: "建单操作人" }));
    expect(await screen.findByText("新员工", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
    expect(employeesApi.list).toHaveBeenCalledWith({ fresh: true });
  });

  it("打开下拉后的旧请求晚到时，不能覆盖刚新增的员工", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await screen.findByText("管理员", { selector: "output" });
    let resolveOld!: (items: EmployeeOption[]) => void;
    vi.mocked(employeesApi.list).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    await user.click(screen.getByRole("combobox", { name: "建单操作人" }));
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalledWith({ fresh: true }));

    await act(async () => { await usersApi.create({ username: added.username }); });
    await waitFor(() => expect(screen.getByTestId("建单员工")).toHaveTextContent("新员工"));
    await act(async () => { resolveOld([original]); });
    expect(await screen.findByText("新员工", { selector: ".ant-select-item-option-content" })).toBeInTheDocument();
  });

  it("重新编辑订单时可取得其他设备新增的员工", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await screen.findByText("管理员", { selector: "output" });
    await user.click(screen.getByRole("button", { name: "编辑订单" }));
    await waitFor(() => expect(screen.getByTestId("编辑状态")).toHaveTextContent("1"));
    await user.click(screen.getByRole("button", { name: "关闭编辑" }));
    employees = [original, added];

    await user.click(screen.getByRole("button", { name: "编辑订单" }));
    await waitFor(() => expect(screen.getByTestId("详情在职员工")).toHaveTextContent("新员工"));
    expect(employeesApi.list).toHaveBeenCalledWith({ fresh: true });
  });

  it("已有员工名单时，刷新未完成也能立即进入订单编辑", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await screen.findByText("管理员", { selector: "output" });
    await user.click(screen.getByRole("button", { name: "编辑订单" }));
    await waitFor(() => expect(screen.getByTestId("编辑状态")).toHaveTextContent("1"));
    await user.click(screen.getByRole("button", { name: "关闭编辑" }));
    let resolveRefresh!: (items: EmployeeOption[]) => void;
    vi.mocked(employeesApi.list).mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));
    await user.click(screen.getByRole("button", { name: "编辑订单" }));
    expect(screen.getByTestId("编辑状态")).toHaveTextContent("1");
    expect(employeesApi.list).toHaveBeenLastCalledWith({ fresh: true });
    await act(async () => { resolveRefresh([original]); });
  });

  it("已打开的建单和订单详情同步新增、改名和停用的员工", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<EmployeeSelectors />, { user: "admin" });
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "编辑订单" }));
    await waitFor(() => expect(employeesApi.list).toHaveBeenCalledTimes(2));

    await act(async () => { await usersApi.create({ username: added.username }); });
    expect(JSON.parse(localStorage.getItem("hj.reference-data-changed") ?? "null")).toMatchObject({ resource: "employees" });

    for (const label of ["建单操作人", "详情操作人"]) {
      await user.click(screen.getByRole("combobox", { name: label }));
      const choices = await screen.findAllByText("新员工", { selector: ".ant-select-item-option-content" });
      const choice = choices[choices.length - 1];
      await user.click(choice);
      expect(screen.getByRole("combobox", { name: label }).closest(".ant-select")).toHaveTextContent("新员工");
    }

    await act(async () => { await usersApi.update(added.id, { display_name: "更名员工" }); });
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
    const previousNotification = localStorage.getItem("hj.reference-data-changed");

    await act(async () => { await expect(usersApi.create({ username: added.username })).rejects.toThrow("保存失败"); });
    expect(employeesApi.list).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("建单员工")).toHaveTextContent("管理员");
    expect(localStorage.getItem("hj.reference-data-changed")).toBe(previousNotification);
  });
});
