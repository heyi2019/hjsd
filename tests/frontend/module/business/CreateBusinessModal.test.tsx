import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import * as client from "@/shared/api/client";
import { CreateBusinessModal } from "@/orders/CreateBusinessModal";
import { DgOrderSection } from "@/orders/dg/DgOrderSection";
import { FieldConfigContext } from "@/orders/ConfigurableField";
import { Form } from "antd";
import { gameTypesApi } from "@/shared/api/misc.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { orderFormFieldsApi, orderTypesApi, ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { resolveMock, resolveMockOnce } from "@fixtures/mock-api";
import { allFormFields, seedOrderFormFields } from "@fixtures/orderFormFieldsSeed";
import { clearOptionSetsCache, loadOptionSets } from "@/shared/lib/optionSets";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

/** 选中建单的主资金账户。 */
async function pickMainPool() {
  const placeholder = screen.getByText("请选择资金账户", { exact: true });
  await ui.click(placeholder.closest(".ant-select")!.querySelector(".ant-select-selector") as Element);
  await ui.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
}
// 自动 mock：所有导出（含嵌套 ordersApi / orderTypesApi / ...）均为 vi.fn()，
// 跨文件在 isolate:false 下复用同一份 mock 实例，配合 setup.ts 的 resetAllMocks
// 与各文件 beforeEach 重新设定返回值，避免闭包捕获的 vi.fn() 在共享模块图下串扰。
vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
  currentUser: vi.fn(),
}));
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");

const types = [{ id: 1, code: "HS", name: "回收", capital_type: "SELF", is_active: true }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.currentUser).mockRejectedValue(new Error("backend unavailable"));
  clearOptionSetsCache();
  seedOrderFormFields();
  vi.mocked(orderTypesApi.list).mockResolvedValue(types);
  resolveMock(vi.mocked(poolsApi.list), [{ id: 1, name: "主账户", code: "MAIN", status: "ACTIVE" }]);
  vi.mocked(employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "系统管理员", is_active: true },
    { id: 2, username: "operator", display_name: "业务员", is_active: true },
  ]);
  vi.mocked(gameTypesApi.list).mockResolvedValue([
    { id: 1, name: "王者荣耀", sort_order: 10, is_active: true, is_default: true },
    { id: 2, name: "原神", sort_order: 20, is_active: true, is_default: false },
  ]);
  resolveMock(vi.mocked(ordersApi.postEvent), { event: { id: 1 }, cashflow_no: "FLOW-0001" });
});

/** 打开弹窗，返回弹窗容器与 onCreated 探针。
 *  rc-select 只在展开后才把选项挂进 DOM，故「等选项出现」前必须先点开下拉。 */
async function openModal(user = "admin") {
  return openTypedModal("HS", user);
}

it("设置面板改板块名后，建单同步显示后端覆盖标题", async () => {
  // 复刻「设置里把『资金明细』改名为『资金明细改名』→ 后端落库 → 建单读配置即时同步」
  vi.mocked(orderFormFieldsApi).listSectionLabels.mockResolvedValue({ FINANCE: "资金明细改名" });
  await openTypedModal("HS");
  // 未覆盖前的硬编码 fallback 不再出现，取而代之的是后端配置的新名
  expect(await screen.findByText("资金明细改名")).toBeInTheDocument();
  expect(screen.queryByText("资金明细")).not.toBeInTheDocument();
});

async function openTypedModal(orderType: string, user = "admin") {
  const onCreated = vi.fn();
  renderLight(<CreateBusinessModal open onClose={() => undefined} onCreated={onCreated} initialOrderType={orderType as "HS" | "TH" | "DG"} />, { user });
  const title = await screen.findByText(orderType === "HS" ? "新建回收订单" : orderType === "TH" ? "新建提号订单" : orderType === "DG" ? "新建代挂订单" : "新建业务");
  return { container: title.closest(".ant-modal-content") as HTMLElement, onCreated };
}

describe("CreateBusinessModal：新建业务写路径", () => {
it("TH 建单的供货方昵称为选填", async () => {
  await openTypedModal("TH");
  const field = screen.getByLabelText("供货方昵称");
  expect(field.closest(".ant-form-item")?.querySelector(".ant-form-item-required")).toBeNull();
});

it("HS 建单客户备注复用账号备注的整行输入样式", async () => {
  await openTypedModal("HS");
  const accountNote = screen.getByLabelText("账号备注");
  const customerNote = screen.getByLabelText("客户备注");
  expect(customerNote.tagName).toBe("INPUT");
  expect(customerNote.closest(".ant-form-item")).toHaveClass("account-note");
  expect(accountNote.closest(".ant-form-item")).toHaveClass("account-note");
});

it.each(["HS", "TH", "DG"])("%s 建单提供换绑手机号字段", async (orderType) => {
  await openTypedModal(orderType);
  expect(screen.getByLabelText("换绑手机号")).toBeInTheDocument();
});

it.each([
  ["HS", "回收操作人"],
  ["TH", "提号操作人"],
  ["DG", "代挂操作人"],
])("%s 在游戏账号信息登记%s", async (orderType, label) => {
  await openTypedModal(orderType);
  expect(screen.getByLabelText(label)).toBeInTheDocument();
});

it.each([
  ["HS", "回收操作人"],
  ["TH", "提号操作人"],
  ["DG", "代挂操作人"],
])("%s 建单的%s为必填且支持多人", async (orderType, label) => {
  await openTypedModal(orderType);
  const field = screen.getByLabelText(label);
  expect(field.closest(".ant-form-item")?.querySelector(".ant-form-item-required")).not.toBeNull();
  expect(field.closest(".ant-select")?.className).toContain("ant-select-multiple");
});

it.each([
  ["HS", "回收操作人"],
  ["TH", "提号操作人"],
  ["DG", "代挂操作人"],
])("%s 建单默认展示当前操作对象%s", async (orderType, label) => {
  await openTypedModal(orderType, "admin");
  const field = screen.getByLabelText(label);
  await waitFor(() => expect(field.closest(".ant-form-item")).toHaveTextContent("系统管理员"));
});

it("回收和代挂均提供手机号绑定人这一核心账号字段", async () => {
  await openTypedModal("HS");
  expect(screen.getByLabelText("手机号绑定人")).toBeInTheDocument();
  await openTypedModal("DG");
  expect((await screen.findAllByLabelText("手机号绑定人")).length).toBeGreaterThan(0);
});

it("回收建单将平台与交付条件集中展示在交付信息", async () => {
  await openTypedModal("HS");

  const deliverySection = (await screen.findByText("交付信息")).closest(".delivery-info-section");
  expect(deliverySection).not.toBeNull();
  expect(within(deliverySection as HTMLElement).getByLabelText("交易平台")).toBeInTheDocument();
  expect(within(deliverySection as HTMLElement).getByLabelText("中介类型")).toBeInTheDocument();
  expect(within(deliverySection as HTMLElement).getByLabelText("包赔类型")).toBeInTheDocument();
});

it("交付信息默认勾选当前员工，并允许追加多位交付操作人", async () => {
  await openTypedModal("HS");

  const deliverySection = (await screen.findByText("交付信息")).closest(".delivery-info-section") as HTMLElement;
  const responsible = within(deliverySection).getByLabelText("交付操作人");
  expect(responsible).toBeInTheDocument();
  await waitFor(() => expect(within(deliverySection).getByText(/系统管理员/)).toBeInTheDocument());
  await ui.click(responsible.closest(".ant-form-item")!.querySelector(".ant-select-selector") as Element);
  await ui.click(await screen.findByText("业务员", { selector: ".ant-select-item-option-content" }));
  expect(within(deliverySection).getByText("业务员")).toBeInTheDocument();
});

it("回收建单在资金信息后展示交付信息", async () => {
  const { container } = await openTypedModal("HS");
  const content = container.textContent ?? "";

  expect(content.indexOf("游戏账号信息")).toBeLessThan(content.indexOf("资金明细"));
  expect(content.indexOf("资金明细")).toBeLessThan(content.indexOf("交付信息"));
  expect(content.indexOf("交付信息")).toBeLessThan(content.indexOf("客户信息"));
});

it("回收建单将资金账户紧跟回收金额，不再展示独立资金流水", async () => {
  const { container } = await openTypedModal("HS");
  const content = container.textContent ?? "";
  expect(screen.getByText("资金明细", { exact: true })).toBeInTheDocument();
  expect(screen.queryByText("资金流水", { exact: true })).toBeNull();
  expect(screen.getByLabelText("资金账户")).toBeInTheDocument();
  expect(content.indexOf("资金明细")).toBeLessThan(content.indexOf("交付信息"));
});

it("代挂建单在交付信息前展示业务信息", async () => {
  renderLight(
    <Form>
      <FieldConfigContext.Provider value={{
        dg_business_note: { id: 401, order_type_code: "DG", field_key: "dg_business_note", label: "代挂方案", field_type: "TEXT", options: null, required: false, is_active: true, sort_order: 1, locked: false, is_custom: true, note: null, section: "BUSINESS" },
      }}>
        <DgOrderSection />
      </FieldConfigContext.Provider>
    </Form>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  const content = document.body.textContent ?? "";
  expect(content.indexOf("代挂方案")).toBeLessThan(content.indexOf("交付信息"));
});

it("回收入口内联填写游戏账号信息，不加载库存账号", async () => {
    const { container } = await openTypedModal("HS");

    expect(await screen.findByLabelText("游戏账号")).toBeInTheDocument();
    expect(screen.queryByLabelText("库存编号")).toBeNull();
    expect(vi.mocked(orderTypesApi.list)).not.toHaveBeenCalled();
  });

it("打开回收入口后只加载订单所需的业务数据", async () => {
    const { container } = await openModal();
    expect(await screen.findByLabelText("游戏账号")).toBeInTheDocument();
    expect(screen.queryByLabelText("库存编号")).toBeNull();
    expect(vi.mocked(orderTypesApi.list)).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("关联账号（必填）");
  });

it("回收订单渲染已启用的其他补充字段", async () => {
  vi.mocked(orderFormFieldsApi.list).mockResolvedValue([
    ...allFormFields(),
    {
      id: 9901,
      order_type_code: "HS",
      field_key: "qa500_recovery_note",
      label: "QA500 回收说明",
      field_type: "TEXT",
      options: null,
      required: false,
      is_active: true,
      sort_order: 999,
      locked: false,
      is_custom: true,
      note: null,
    },
  ]);

  await openModal();

  await screen.findByLabelText("客户昵称");
  expect(screen.getByLabelText("QA500 回收说明")).toBeInTheDocument();
  expect(screen.getByTestId("custom-fields-extra")).toBeInTheDocument();
});

it("必填校验：未选业务类型不给提交", async () => {
    await openModal();
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    await waitFor(() => expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled());
  });

it("必填校验失败时显示表单级提示，避免误认为点击无效", async () => {
    await openModal();
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请补齐必填项后再创建订单");
    expect(vi.mocked(ordersApi.create)).not.toHaveBeenCalled();
  });

it("建单失败时错误落到弹窗内 ErrorBanner（不静默）", async () => {
    vi.mocked(ordersApi.create).mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "POOL_ROUTE_MISSING", message: "缺少资金池路由" } },
      message: "Request failed",
    });
    const { container } = await openTypedModal("TH");
    await ui.type(screen.getByLabelText("供货方昵称"), "同行甲");
    await ui.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await ui.type(screen.getByLabelText("游戏账号"), "pickup-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.type(screen.getByLabelText("渠道／区服"), "安卓一区");
    const amounts = screen.getAllByPlaceholderText("请输入金额");
    await ui.type(amounts[0], "1000");
    await pickMainPool();
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    expect(await screen.findByText(/设置 → 主数据/)).toBeInTheDocument();
  });

it("FE-023：未售出的相同游戏账号由后端拒绝并保留表单", async () => {
    // 判重已后移到后端：前端不再拉库存台账比对，只呈现后端错误。
    vi.mocked(ordersApi.create).mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        data: {
          code: "INVENTORY_ACCOUNT_IN_STOCK",
          message: "已有未售出库存账号「pickup-account」，请先售出后再建单",
        },
      },
      message: "Request failed",
    });
    await openTypedModal("TH");
    await ui.type(screen.getByLabelText("供货方昵称"), "同行甲");
    await ui.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await ui.type(screen.getByLabelText("游戏账号"), "pickup-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.type(screen.getByLabelText("渠道／区服"), "安卓一区");
    const amounts = screen.getAllByPlaceholderText("请输入金额");
    await ui.type(amounts[0], "1000");
    await pickMainPool();
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    await waitFor(() => expect(screen.getByText(/请先售出后再建单/)).toBeInTheDocument());
    expect(screen.getByLabelText("游戏账号")).toHaveValue("pickup-account");
    // 未售出属硬阻止：只出错误提示，不应弹复购确认框（ConfirmDialog）。
    expect(screen.queryByText("检测到重复游戏账号")).not.toBeInTheDocument();
    // 请求已经发出，由后端判定；前端不自带判重。
    expect(ordersApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ confirm_repurchase: false }),
    );
    await ui.clear(screen.getByLabelText("游戏账号"));
    await ui.type(screen.getByLabelText("游戏账号"), "pickup-account-new");
    expect(screen.queryByText(/请先售出后再建单/)).not.toBeInTheDocument();
  });

it("FE-023：已售出的相同游戏账号按复购确认后允许回流建单", async () => {
    vi.mocked(ordersApi.create)
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          data: {
            code: "REPURCHASE_CONFIRM_REQUIRED",
            message: "历史库存账号「pickup-account」已售出，请确认是否为复购回流订单",
          },
        },
        message: "Request failed",
      })
      .mockResolvedValueOnce({ id: 1 } as never);
    await openTypedModal("TH");
    await ui.type(screen.getByLabelText("供货方昵称"), "同行甲");
    await ui.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await ui.type(screen.getByLabelText("游戏账号"), "pickup-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.type(screen.getByLabelText("渠道／区服"), "安卓一区");
    const amounts = screen.getAllByPlaceholderText("请输入金额");
    await ui.type(amounts[0], "1000");
    await pickMainPool();
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    // 后端要求确认复购：复购确认框出现，未确认前不再次提交。
    expect(await screen.findByText("检测到重复游戏账号")).toBeInTheDocument();
    expect(ordersApi.create).toHaveBeenCalledTimes(1);
    // 复购确认用 ConfirmDialog（Modal 级）：按可访问名精确点击，兼作 loading 图标污染的回归护栏。
    await ui.click(screen.getByRole("button", { name: "是，继续建单" }));
    await waitFor(() => expect(ordersApi.create).toHaveBeenCalledTimes(2));
    expect(ordersApi.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirm_repurchase: true }),
    );
  });

it("订单已创建后不等待列表刷新，提交按钮立即结束 loading", async () => {
    resolveMockOnce(vi.mocked(ordersApi.create), { id: 31, order_no: "TH-2026-0031", status: "ACTIVE" });
    let resolveRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => { resolveRefresh = resolve; });
    const onClose = vi.fn();
    renderLight(
      <CreateBusinessModal open onClose={onClose} onCreated={() => refresh} initialOrderType="TH" />,
      { user: "admin" },
    );
    await screen.findByLabelText("供货方昵称");
    await ui.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await ui.type(screen.getByLabelText("游戏账号"), "pickup-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.type(screen.getByLabelText("渠道／区服"), "安卓一区");
    await ui.type(screen.getByLabelText("供货方昵称"), "同行甲");
    const amounts = screen.getAllByPlaceholderText("请输入金额");
    await ui.type(amounts[0], "1000");
    await pickMainPool();
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    await waitFor(() => expect(vi.mocked(ordersApi.create)).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const button = screen.getByRole("button", { name: /创建订单/ });
    expect(button.className).not.toContain("ant-btn-loading");
    resolveRefresh();
  });

it("支出明细只保留金额和备注", async () => {
    await openModal();
    expect(screen.queryByLabelText("设计费")).toBeNull();
  expect(screen.queryByLabelText("收款对象")).toBeNull();
  expect(screen.queryByLabelText("其他")).toBeNull();
  expect(screen.getByRole("button", { name: /增加支出/ })).toBeInTheDocument();
  await ui.click(screen.getByRole("button", { name: /增加支出/ }));
  expect(screen.getByLabelText("支出备注")).toBeInTheDocument();
  });

it("viewer 无 order.create → 提交按钮不渲染（入口由页面层 PermissionGate 决定）", async () => {
    await openModal("viewer");
    expect(screen.queryByRole("button", { name: /创建订单/ })).toBeNull();
  });

it("P1-剩①：回收建单把交付字段随订单写入 form_extra", async () => {
    clearOptionSetsCache();
    vi.mocked(optionSetsApi.list).mockResolvedValueOnce({
      items: [
        { code: "INTERMEDIARY_PLATFORM", options: [{ value: "盼之", label: "盼之" }] },
        { code: "INTERMEDIARY_TYPE", options: [{ value: "包赔", label: "包赔" }] },
        { code: "COMPENSATION_TYPE", options: [{ value: "shoubao", label: "首保" }] },
      ],
    } as never);
    await loadOptionSets();

    resolveMockOnce(vi.mocked(ordersApi.create), { id: 31, order_no: "HS-2026-0031", status: "ACTIVE" });
    const onClose = vi.fn();
    await openTypedModal("HS", "admin");
    await ui.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await ui.type(screen.getByLabelText("游戏账号"), "recovery-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.type(screen.getByLabelText("渠道／区服"), "安卓一区");
    await ui.type(screen.getByLabelText("客户昵称"), "张三");
    await ui.type(screen.getByPlaceholderText("请输入金额"), "1000");
    await pickMainPool();
    // 交付信息
    await ui.type(screen.getByLabelText("手机号绑定人"), "张三");
    await ui.click(screen.getByLabelText("交易平台").closest(".ant-form-item")!.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("盼之", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByLabelText("中介类型").closest(".ant-form-item")!.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("包赔", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByLabelText("包赔类型").closest(".ant-form-item")!.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("首保", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    await waitFor(() => expect(vi.mocked(ordersApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(ordersApi.create).mock.calls[0][0] as Record<string, unknown>;
    const formExtra = (payload.form_extra ?? {}) as Record<string, unknown>;
    expect(formExtra.intermediary_platform).toBe("盼之");
    expect(formExtra.intermediary_type).toBe("包赔");
    expect(formExtra.compensation_type).toBe("shoubao");
    expect(formExtra.bound_phone_owner).toBe("张三");
  });

  it("P2-198：仅展开下拉未改值，关闭直接关闭不弹放弃确认", async () => {
    const onClose = vi.fn();
    renderLight(
      <CreateBusinessModal open onClose={onClose} onCreated={() => undefined} initialOrderType="HS" />,
      { user: "admin" },
    );
    await screen.findByText("新建回收订单");
    // 仅展开「资金账户」下拉（默认已注入主账户选项），不选择任何值
    const selector = screen.getByLabelText("资金账户").closest(".ant-form-item")!.querySelector(".ant-select-selector") as Element;
    await ui.click(selector);
    await waitFor(() => expect(screen.getByText("主账户", { selector: ".ant-select-item-option-content" })).toBeInTheDocument());
    await ui.click(selector); // 收起下拉
    // 点关闭（X）：未改值 → 直接关闭，不应弹确认
    await ui.click(document.querySelector(".ant-modal-close") as Element);
    // 未改值：不出现放弃确认框（ConfirmDialog），直接关闭
    expect(screen.queryByText("放弃未保存的建单内容？")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("P2-198：已改值关闭弹出放弃确认，确认后关闭", async () => {
    const onClose = vi.fn();
    renderLight(
      <CreateBusinessModal open onClose={onClose} onCreated={() => undefined} initialOrderType="HS" />,
      { user: "admin" },
    );
    await screen.findByText("新建回收订单");
    await ui.type(screen.getByLabelText("客户昵称"), "改了点东西");
    await ui.click(document.querySelector(".ant-modal-close") as Element);
    // 已改值：弹出放弃确认框（ConfirmDialog），点「放弃」后才关闭
    expect(await screen.findByText("放弃未保存的建单内容？")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await ui.click(screen.getByRole("button", { name: "放弃" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("放弃确认框可用 X 收起：不关闭表单，也不触发 onClose", async () => {
    const onClose = vi.fn();
    renderLight(
      <CreateBusinessModal open onClose={onClose} onCreated={() => undefined} initialOrderType="HS" />,
      { user: "admin" },
    );
    await screen.findByText("新建回收订单");
    await ui.type(screen.getByLabelText("客户昵称"), "改了点东西");
    await ui.click(document.querySelector(".ant-modal-close") as Element);
    const title = await screen.findByText("放弃未保存的建单内容？");

    // 点的是确认框自身的 X（不是主弹窗的 X）：应从确认框容器内部取。
    const confirmBox = title.closest(".ant-modal-content") as HTMLElement;
    await ui.click(confirmBox.querySelector(".ant-modal-close") as Element);

    // X 的语义是「取消放弃」＝继续编辑：不得关表单、不得触发 onClose。
    // 注：确认框 DOM 是否真的隐藏属 antd 渲染层行为，jsdom + motion-stub 下关闭后
    // 节点不会移除，断言必然失真；该收尾由 E2E（cross/business-write.spec.ts）守护。
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("新建回收订单")).toBeInTheDocument();
  });
});
