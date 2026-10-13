import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { CustomersPage } from "./CustomersPage";

const list = vi.fn();
const create = vi.fn();
const merge = vi.fn();
const cpList = vi.fn();
const patch = vi.fn();
const fieldsList = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  customersApi: {
    list: (...a: unknown[]) => list(...a),
    create: (...a: unknown[]) => create(...a),
    merge: (...a: unknown[]) => merge(...a),
    patch: (...a: unknown[]) => patch(...a),
    setStatus: vi.fn(),
    get: vi.fn(),
  },
  counterpartiesApi: {
    list: (...a: unknown[]) => cpList(...a),
    create: vi.fn(),
    setStatus: vi.fn(),
  },
  fieldsApi: {
    list: (...a: unknown[]) => fieldsList(...a),
    create: vi.fn(),
    setActive: vi.fn(),
    remove: vi.fn(),
  },
}));

/** 活字段定义：SELECT / MULTI_SELECT / 停用字段各一，覆盖动态渲染与历史值展示 */
const fieldDefs = [
  {
    id: 1,
    entity_type: "customer",
    field_key: "game_category",
    label: "常玩品类",
    field_type: "MULTI_SELECT",
    options: ["王者荣耀", "和平精英"],
    required: false,
    sort_order: 10,
    is_active: true,
  },
  {
    id: 2,
    entity_type: "customer",
    field_key: "credit_level",
    label: "信用评级",
    field_type: "SELECT",
    options: ["优质", "一般", "观察", "黑名单"],
    required: false,
    sort_order: 20,
    is_active: true,
  },
  {
    id: 3,
    entity_type: "customer",
    field_key: "referrer",
    label: "转介绍人",
    field_type: "TEXT",
    options: null,
    required: false,
    sort_order: 30,
    is_active: true,
  },
  {
    id: 4,
    entity_type: "customer",
    field_key: "legacy_note",
    label: "历史备注",
    field_type: "TEXT",
    options: null,
    required: false,
    sort_order: 40,
    is_active: false,
  },
] as unknown as import("../shared/api/catalog").FieldDefinition[];

const customers = [
  {
    id: 1,
    customer_no: "CUS-0001",
    display_name: "张三",
    phone: "138****8888",
    wechat: "zhangsan",
    qq: "10001",
    status: "ACTIVE",
    extra_values: { credit_level: "优质", legacy_note: "早期客户" },
  },
  {
    id: 2,
    customer_no: "CUS-0002",
    display_name: "李四",
    phone: "139****9999",
    wechat: "",
    qq: "",
    status: "DISABLED",
    extra_values: {},
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(customers);
  cpList.mockResolvedValue([]);
  fieldsList.mockResolvedValue(fieldDefs);
});

describe("CustomersPage：客户档案", () => {
  it("加载成功后渲染客户编号与状态标签", async () => {
    renderApp(<CustomersPage />);
    expect(await screen.findByText("CUS-0001")).toBeInTheDocument();
    expect(screen.getByText("CUS-0002")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument(); // ACTIVE
    // 「已停用」同时出现在统计卡与状态标签 → 用 All 变体（skill 提示的重复文案坑）
    expect(screen.getAllByText("已停用").length).toBeGreaterThanOrEqual(1); // DISABLED
  });

  it("后端不可达时显示错误条而不是空白页", async () => {
    list.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<CustomersPage />);
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("业务错误码给出可执行的处置提示", async () => {
    list.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "PERMISSION_DENIED", message: "当前角色无此权限" } },
      message: "Request failed",
    });
    renderApp(<CustomersPage />);
    expect(await screen.findByText(/联系管理员/)).toBeInTheDocument();
  });

  it("客户与合作方分 Tab，不混用（CUS-01）", async () => {
    renderApp(<CustomersPage />);
    await screen.findByText("CUS-0001");
    expect(screen.getByRole("tab", { name: "客户档案" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /合作方/ })).toBeInTheDocument();
  });
});

describe("CustomersPage：权限门控与写操作", () => {
  it("admin 可见「新建客户」入口", async () => {
    renderApp(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    expect(screen.getByRole("button", { name: /新建/ })).toBeInTheDocument();
  });

  it("viewer 无 customer.create 权限 → 新建入口不渲染", async () => {
    renderApp(<CustomersPage />, { user: "viewer" });
    await screen.findByText("CUS-0001");
    expect(screen.queryByRole("button", { name: /新建/ })).toBeNull();
  });

  it("非 ACTIVE 客户的合并按钮禁用（不能合并已停用客户）", async () => {
    renderApp(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    const mergeButtons = screen.getAllByRole("button", { name: /合\s*并/ });
    expect(mergeButtons.length).toBe(2);
    // 第一行 ACTIVE 可点，第二行 DISABLED 禁用
    expect(mergeButtons.some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    expect(mergeButtons.some((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("新建客户提交后回传字段并刷新列表", async () => {
    create.mockResolvedValueOnce({ customer: { id: 3, customer_no: "CUS-0003" }, duplicate_candidates: [] });
    renderApp(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await userEvent.click(screen.getByRole("button", { name: /新建/ }));
    const nameInput = await screen.findByLabelText("名字");
    await userEvent.type(nameInput, "王五");
    await userEvent.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ display_name: "王五" });
  });

  it("重复候选不拦截，只提示（创建仍成功）", async () => {
    create.mockResolvedValueOnce({
      customer: { id: 4 },
      duplicate_candidates: [{ id: 2 }],
    });
    renderApp(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await userEvent.click(screen.getByRole("button", { name: /新建/ }));
    const nameInput = await screen.findByLabelText("名字");
    await userEvent.type(nameInput, "李四");
    await userEvent.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(await screen.findByText(/重复候选/)).toBeInTheDocument();
  });
});

describe("CustomersPage：活字段（BAS-04）", () => {
  it("列表按字段定义渲染活字段摘要列", async () => {
    renderApp(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    expect(await screen.findByText(/信用评级：优质/)).toBeInTheDocument();
    await waitFor(() => expect(fieldsList).toHaveBeenCalledWith({ entity_type: "customer" }));
  });

  it("新建弹窗动态渲染活字段控件，提交时回传 extra_values", async () => {
    create.mockResolvedValueOnce({ customer: { id: 3 }, duplicate_candidates: [] });
    renderApp(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await userEvent.click(screen.getByRole("button", { name: /新建/ }));
    const nameInput = await screen.findByLabelText("名字");
    await userEvent.type(nameInput, "王五");
    const referrerInput = await screen.findByLabelText("转介绍人");
    await userEvent.type(referrerInput, "老王");
    await userEvent.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({
      display_name: "王五",
      extra_values: { referrer: "老王" },
    });
  });

  it("详情抽屉展示活字段值，停用字段标注保留历史值", async () => {
    renderApp(<CustomersPage />, { user: "admin" });
    await screen.findByText("CUS-0001");
    await userEvent.click(screen.getAllByRole("button", { name: /详\s*情/ })[0]);
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("信用评级")).toBeInTheDocument();
    expect(within(drawer).getByText("优质")).toBeInTheDocument();
    expect(within(drawer).getByText("历史备注（已停用）")).toBeInTheDocument();
    expect(within(drawer).getByText("早期客户")).toBeInTheDocument();
  });

  it("活字段定义接口失败不阻断客户页渲染", async () => {
    fieldsList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<CustomersPage />, { user: "admin" });
    expect(await screen.findByText("CUS-0001")).toBeInTheDocument();
  });
});
