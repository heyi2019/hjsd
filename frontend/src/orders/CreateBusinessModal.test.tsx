import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { CreateBusinessModal } from "./CreateBusinessModal";
import { DgOrderSection } from "./dg/DgOrderSection";
import { FieldConfigContext } from "./ConfigurableField";
import { Form } from "antd";
import * as catalog from "../shared/api/catalog";
import { resolveMock, resolveMockOnce } from "../test/mock-api";
import { allFormFields, seedOrderFormFields } from "../test/formFieldsSeed";
import { clearOptionSetsCache, loadOptionSets } from "../shared/lib/optionSets";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});
// 自动 mock：所有导出（含嵌套 ordersApi / orderTypesApi / ...）均为 vi.fn()，
// 跨文件在 isolate:false 下复用同一份 mock 实例，配合 setup.ts 的 resetAllMocks
// 与各文件 beforeEach 重新设定返回值，避免闭包捕获的 vi.fn() 在共享模块图下串扰。
vi.mock("../shared/api/catalog");

const types = [{ id: 1, code: "HS", name: "回收", capital_type: "SELF", is_active: true }];

beforeEach(() => {
  vi.clearAllMocks();
  clearOptionSetsCache();
  seedOrderFormFields(catalog);
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(types);
  vi.mocked(catalog.customersApi.list).mockResolvedValue([{ id: 1, customer_no: "CUS-0001", display_name: "张三", status: "ACTIVE" }]);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([{ id: 2, counterparty_no: "CP-0001", display_name: "同行甲", type: "PEER", status: "ACTIVE" }]);
  resolveMock(vi.mocked(catalog.stocksApi.list), [
    { id: 9, game_account: "recovery-account", business_mode: "SELF", inventory_type: "RECOVERY", status: "WAITING", cost_amount: "0.00" },
    { id: 10, game_account: "consignment-account", business_mode: "DISTRIBUTION", inventory_type: "CONSIGNMENT", status: "WAITING", cost_amount: "0.00" },
    { id: 11, game_account: "pickup-account", business_mode: "DISTRIBUTION", inventory_type: "PICKUP", status: "WAITING", cost_amount: "0.00" },
  ]);
  resolveMock(vi.mocked(catalog.poolsApi.list), [{ id: 1, name: "主账户", code: "MAIN", status: "ACTIVE" }]);
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([
    { id: 1, username: "admin", display_name: "系统管理员", is_active: true },
    { id: 2, username: "operator", display_name: "业务员", is_active: true },
  ]);
  vi.mocked(catalog.gameTypesApi.list).mockResolvedValue([
    { id: 1, name: "王者荣耀", sort_order: 10, is_active: true, is_default: true },
    { id: 2, name: "原神", sort_order: 20, is_active: true, is_default: false },
  ]);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([{ id: 10, order_no: "HJ-HS-0001", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-15", status: "ACTIVE", account_id: 9 }]);
  resolveMock(vi.mocked(catalog.ordersApi.postEvent), { event: { id: 1 }, cashflow_no: "FLOW-0001" });
});

/** 打开弹窗，返回弹窗容器与 onCreated 探针。
 *  rc-select 只在展开后才把选项挂进 DOM，故「等选项出现」前必须先点开下拉。 */
async function openModal(user = "admin") {
  return openTypedModal("HS", user);
}

it("设置面板改板块名后，建单同步显示后端覆盖标题", async () => {
  // 复刻「设置里把『资金明细』改名为『资金明细改名』→ 后端落库 → 建单读配置即时同步」
  vi.mocked(catalog.orderFormFieldsApi).listSectionLabels.mockResolvedValue({ FINANCE: "资金明细改名" });
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
it.each(["HS", "TH", "DG"])("%s 建单提供换绑手机号字段", async (orderType) => {
  await openTypedModal(orderType);
  expect(screen.getByLabelText("换绑手机号")).toBeInTheDocument();
});

it.each([
  ["HS", "回收负责人"],
  ["TH", "提号负责人"],
  ["DG", "代挂负责人"],
])("%s 在游戏账号信息登记%s", async (orderType, label) => {
  await openTypedModal(orderType);
  expect(screen.getByLabelText(label)).toBeInTheDocument();
});

it("回收和代挂均提供手机号绑定人这一核心账号字段", async () => {
  await openTypedModal("HS");
  expect(screen.getByLabelText("手机号绑定人")).toBeInTheDocument();
  await openTypedModal("DG");
  expect((await screen.findAllByLabelText("手机号绑定人")).length).toBeGreaterThan(0);
});

it("回收建单将平台与交付条件集中展示在交付信息", async () => {
  await openTypedModal("HS");

  const deliverySection = (await screen.findByText("交付信息")).closest("section");
  expect(deliverySection).not.toBeNull();
  expect(within(deliverySection as HTMLElement).getByLabelText("交易平台")).toBeInTheDocument();
  expect(within(deliverySection as HTMLElement).getByLabelText("中介类型")).toBeInTheDocument();
  expect(within(deliverySection as HTMLElement).getByLabelText("包赔类型")).toBeInTheDocument();
});

it("交付信息默认勾选当前员工，并允许追加多位交付负责人", async () => {
  await openTypedModal("HS");

  const deliverySection = (await screen.findByText("交付信息")).closest("section") as HTMLElement;
  const responsible = within(deliverySection).getByLabelText("交付负责人");
  expect(responsible).toBeInTheDocument();
  await waitFor(() => expect(within(deliverySection).getByText(/系统管理员/)).toBeInTheDocument());
  await ui.click(responsible.closest(".ant-form-item")!.querySelector(".ant-select-selector") as Element);
  await ui.click(await screen.findByText(/业务员（operator）/, { selector: ".ant-select-item-option-content" }));
  expect(within(deliverySection).getByText(/业务员（operator）/)).toBeInTheDocument();
});

it("回收建单在资金信息后展示交付信息", async () => {
  const { container } = await openTypedModal("HS");
  const content = container.textContent ?? "";

  expect(content.indexOf("游戏账号信息")).toBeLessThan(content.indexOf("资金明细"));
  expect(content.indexOf("资金明细")).toBeLessThan(content.indexOf("交付信息"));
  expect(content.indexOf("交付信息")).toBeLessThan(content.indexOf("客户信息"));
});

it("回收建单将支出账户紧跟账号号价，不再展示独立资金流水", async () => {
  const { container } = await openTypedModal("HS");
  const content = container.textContent ?? "";
  expect(screen.getByText("资金明细", { exact: true })).toBeInTheDocument();
  expect(screen.queryByText("资金流水", { exact: true })).toBeNull();
  expect(screen.getByLabelText("支出账户")).toBeInTheDocument();
  expect(content.indexOf("资金明细")).toBeLessThan(content.indexOf("交付信息"));
});

it("代挂建单在交付信息前展示业务信息", () => {
  renderLight(
    <Form>
      <FieldConfigContext.Provider value={{
        dg_business_note: { id: 401, order_type_code: "DG", field_key: "dg_business_note", label: "代挂方案", field_type: "TEXT", options: null, required: false, is_active: true, sort_order: 1, locked: false, is_custom: true, note: null, section: "BUSINESS" },
      }}>
        <DgOrderSection />
      </FieldConfigContext.Provider>
    </Form>,
  );
  const content = document.body.textContent ?? "";
  expect(content.indexOf("代挂方案")).toBeLessThan(content.indexOf("交付信息"));
});

it("回收入口内联填写游戏账号信息，不加载库存账号", async () => {
    const { container } = await openTypedModal("HS");

    expect(await screen.findByLabelText("游戏账号")).toBeInTheDocument();
    expect(screen.queryByLabelText("库存编号")).toBeNull();
    expect(vi.mocked(catalog.stocksApi.list)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.ordersApi.list)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.orderTypesApi.list)).not.toHaveBeenCalled();
  });

it("打开回收入口后只加载订单所需的业务数据", async () => {
    const { container } = await openModal();
    expect(await screen.findByLabelText("游戏账号")).toBeInTheDocument();
    expect(screen.queryByLabelText("库存编号")).toBeNull();
    expect(vi.mocked(catalog.orderTypesApi.list)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.stocksApi.list)).not.toHaveBeenCalled();
    expect(vi.mocked(catalog.ordersApi.list)).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("关联账号（必填）");
  });

it("回收订单渲染已启用的其他补充字段", async () => {
  vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue([
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
    await waitFor(() => expect(vi.mocked(catalog.ordersApi.create)).not.toHaveBeenCalled());
  });

it("建单失败时错误落到弹窗内 ErrorBanner（不静默）", async () => {
    vi.mocked(catalog.ordersApi.create).mockRejectedValueOnce({
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
    await ui.click(screen.getByLabelText("供货方来源").closest(".ant-form-item")?.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("氪金联盟", { selector: ".ant-select-item-option-content" }));
    const amounts = screen.getAllByPlaceholderText("请输入金额");
    await ui.type(amounts[0], "1000");
    await ui.type(amounts[1], "1200");
    await ui.click(screen.getByText("请选择支出账户", { exact: true }).closest(".ant-select")!.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    expect(await screen.findByText(/设置 → 主数据/)).toBeInTheDocument();
  });

it("FE-023：未售出的相同游戏账号直接阻止建单并保留表单", async () => {
    const confirmSpy = vi.spyOn(appModal, "confirm");
    vi.mocked(catalog.stocksApi.list).mockResolvedValueOnce([
      { id: 99, game_account: "pickup-account", game_type: "王者荣耀", status: "WAITING" },
    ] as never);
    await openTypedModal("TH");
    await ui.type(screen.getByLabelText("供货方昵称"), "同行甲");
    await ui.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await ui.type(screen.getByLabelText("游戏账号"), "pickup-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.type(screen.getByLabelText("渠道／区服"), "安卓一区");
    const amounts = screen.getAllByPlaceholderText("请输入金额");
    await ui.type(amounts[0], "1000");
    await ui.type(amounts[1], "1200");
    await ui.click(screen.getByText("请选择支出账户", { exact: true }).closest(".ant-select")!.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    await waitFor(() => expect(screen.getByText(/请先售出后再建单/)).toBeInTheDocument());
    expect(screen.getByLabelText("游戏账号")).toHaveValue("pickup-account");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(catalog.ordersApi.create).not.toHaveBeenCalled();
  });

it("FE-023：已售出的相同游戏账号按复购确认后允许回流建单", async () => {
    vi.mocked(catalog.stocksApi.list).mockResolvedValueOnce([
      { id:99, game_account: "pickup-account", game_type: "王者荣耀", status: "SOLD" },
    ] as never);
    await openTypedModal("TH");
    await ui.type(screen.getByLabelText("供货方昵称"), "同行甲");
    await ui.type(screen.getByLabelText("游戏类型"), "王者荣耀");
    await ui.type(screen.getByLabelText("游戏账号"), "pickup-account");
    await ui.type(screen.getByLabelText("账号密码"), "secret");
    await ui.type(screen.getByLabelText("渠道／区服"), "安卓一区");
    const amounts = screen.getAllByPlaceholderText("请输入金额");
    await ui.type(amounts[0], "1000");
    await ui.type(amounts[1], "1200");
    await ui.click(screen.getByText("请选择支出账户", { exact: true }).closest(".ant-select")!.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    // 复购确认框出现，未确认前不建单
    expect(await screen.findByText("检测到重复游戏账号")).toBeInTheDocument();
    expect(catalog.ordersApi.create).not.toHaveBeenCalled();
    // 复购确认用 ConfirmDialog（Modal 级）：rc-motion 测试桩强制 visible 会让 antd Button 渲染
    // loading 图标并污染 getByRole 的 name，故用正则按文案匹配（真实运行不受影响）。
    await ui.click(screen.getByRole("button", { name: /是，继续建单/ }));
    await waitFor(() => expect(catalog.ordersApi.create).toHaveBeenCalled());
  });

it("FE-123：原建单测试入口的提号来源默认值跟随主数据", async () => {
    clearOptionSetsCache();
    vi.mocked(catalog.optionSetsApi.list).mockResolvedValueOnce({
      items: [{ code: "SUPPLIER_SOURCE", options: [{ value: "自营", label: "自营" }, { value: "其他", label: "其他" }] }],
    } as never);
    await loadOptionSets();
    renderLight(<CreateBusinessModal open onClose={() => undefined} onCreated={() => undefined} initialOrderType="TH" />, { user: "admin" });
    const field = await screen.findByLabelText("供货方来源");
    await waitFor(() => expect(field.closest(".ant-select")?.querySelector(".ant-select-selection-item")).toHaveTextContent("自营"));
  });

it("订单已创建后不等待列表刷新，提交按钮立即结束 loading", async () => {
    resolveMockOnce(vi.mocked(catalog.ordersApi.create), { id: 31, order_no: "TH-2026-0031", status: "ACTIVE" });
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
    await ui.click(screen.getByLabelText("供货方来源").closest(".ant-form-item")?.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("氪金联盟", { selector: ".ant-select-item-option-content" }));
    const amounts = screen.getAllByPlaceholderText("请输入金额");
    await ui.type(amounts[0], "1000");
    await ui.type(amounts[1], "1200");
    await ui.click(screen.getByText("请选择支出账户", { exact: true }).closest(".ant-select")!.querySelector(".ant-select-selector") as Element);
    await ui.click(await screen.findByText("主账户", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: /创建订单/ }));
    await waitFor(() => expect(vi.mocked(catalog.ordersApi.create)).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const button = screen.getByRole("button", { name: /创建订单/ });
    expect(button.className).not.toContain("ant-btn-loading");
    resolveRefresh();
  });

it("附加费用只保留中介费", async () => {
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
});
