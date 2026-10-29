import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../shared/api/catalog";
vi.mock("../shared/api/catalog");
import * as client from "../shared/api/client";
import { renderLight } from "../test/render";
import { SettingsPage } from "./SettingsPage";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

// vi.hoisted：保证 const 在 vi.mock 工厂执行前完成初始化，避免 TDZ（直接返回对象引用会触发）。


vi.mock("../shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/api/client")>()),
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  login: vi.fn(),
  logout: vi.fn(),
  setDevUser: vi.fn(),
  changePassword: vi.fn(),
  checkBackendHealth: vi.fn(),
}));

const orderTypes = [
  { id: 1, code: "HS", name: "回收", capital_type: "OWNED", is_active: true },
] as unknown as import("../shared/api/catalog").OrderType[];

const pools = [
  { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
] as unknown as import("../shared/api/catalog").Pool[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(orderTypes);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue(pools);
  vi.mocked(catalog.optionSetsApi.list).mockResolvedValue({ items: [] });
  vi.mocked(catalog.gameTypesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue([]);
  vi.mocked(catalog.policyApi.list).mockResolvedValue({ items: [], total: 0 });
  vi.mocked(client.api).get.mockResolvedValue({ data: [] });
});

it("业务字典仅说明业务口径，不展示配置跳转按钮", async () => {
  renderLight(<SettingsPage />, { user: "admin" });
  const tabs = await screen.findAllByRole("tab");
  expect(tabs.slice(0, 3).map((tab) => tab.textContent)).toEqual([
    "业务字典",
    "业务类型",
      "表单字段",
  ]);
  expect(screen.getByText("业务分类口径")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /配置字段与表单/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /管理扩展字段/ })).toBeNull();
  expect(screen.queryByRole("tab", { name: "选项词典" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "配置总览" })).toBeNull();

  expect(screen.getByRole("tab", { name: "业务类型" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "资金池" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "经营规则" })).toBeInTheDocument();
  // 业务字典作为入口时，业务类型面板尚未挂载。
  expect(screen.queryByText("HS")).toBeNull();
  await ui.click(screen.getByRole("tab", { name: "业务类型" }));
  expect(await screen.findByText("HS")).toBeInTheDocument();
});

it("业务分类明确分期归自营、代分期归分销", async () => {
  renderLight(<SettingsPage />, { user: "admin" });
  // 默认 Tab 是业务字典。
  expect(await screen.findByText("分期（自营增值服务）", { exact: true })).toBeInTheDocument();
  expect(screen.getByText(/本方账号售出后，买家分期支付售卖款/)).toBeInTheDocument();
  expect(screen.getByText("代分期（分销增值服务）", { exact: true })).toBeInTheDocument();
  expect(screen.getByText(/客户向本方借款并按合约分期还款/)).toBeInTheDocument();
});

it("库存管理下单独展示分期管理口径", async () => {
  renderLight(<SettingsPage />, { user: "admin" });

  expect(await screen.findByText("分期管理", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("自营分期", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("代分期", { exact: true })).toBeInTheDocument();
  expect(screen.getByText(/按期登记买家回款/)).toBeInTheDocument();
  expect(screen.getByText(/分别登记付款、收款/)).toBeInTheDocument();
  expect(screen.getByText("自营分期", { exact: true }).textContent).not.toContain("增值服务");
});

it("业务动作按账号生命周期、资金动作和账务动作分层", async () => {
  renderLight(<SettingsPage />, { user: "admin" });

  expect((await screen.findAllByText("创建订单", { exact: true })).length).toBe(2);
  expect(await screen.findByText("买号入库", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("回收入库")).toBeInTheDocument();
  expect(screen.getByText("提号入库")).toBeInTheDocument();
  expect(screen.getByText("代挂入库")).toBeInTheDocument();
  expect(screen.getByText("寄售上架", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("寄售下架", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("账号描述维护", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("账号图片维护", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("代分期入库")).toBeInTheDocument();
  expect(screen.getByText("买号交付", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("卖号出库", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("卖号交付", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("资金动作", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("账务动作", { exact: true })).toBeInTheDocument();
  expect(screen.queryByText("二级分类", { exact: true })).toBeNull();
  expect(screen.queryByText("三级分类", { exact: true })).toBeNull();
  expect(screen.queryByText("动作说明", { exact: true })).toBeNull();
  expect(screen.getByText("自营", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("收入", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("支出", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("售出收款", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("退款收入", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("过账", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("冲销", { exact: true })).toBeInTheDocument();
  expect(document.querySelectorAll(".business-dictionary__action-line").length).toBeGreaterThan(20);
  expect(document.body.textContent).toContain("换绑手机号、手机号绑定人、交易平台或中介信息");
  expect(screen.getAllByText("账号交付", { exact: true })).toHaveLength(2);
  expect(document.body.textContent).toContain("全款、分期结清和代挂售出统一记录");
  expect(document.body.textContent).toContain("记录订单创建审计事件");
  expect(document.body.textContent).toContain("记录售出过账审计事件");
  expect(document.body.textContent).toContain("每期收款归集到原售出订单及其分期合约");
  expect(document.body.textContent).toContain("退款、押金等按实际方向登记");
  expect(document.body.textContent).toContain("手续费另记支出");
  expect(document.body.textContent).toContain("登记平台费、中介费等附加费用");
  expect(document.body.textContent).toContain("登记退给客户或其他收款方的退款");
  expect(document.body.textContent).toContain("记录交付登记审计事件");
  expect(screen.getByText("售出取消交易", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("库存取消交易", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("分期取消交易", { exact: true })).toBeInTheDocument();
  expect(document.body.textContent).toContain("回收取消、提号取消");
  expect(document.body.textContent).toContain("账号退出库存中心");
  expect(document.body.textContent).toContain("账号回到库存中心");
  expect(document.body.textContent).toContain("回收、提号、代分期、代挂四类售出订单");
  expect(document.body.textContent).toContain("代分期取消");
  expect(document.body.textContent).toContain("代挂取消（系统下架）");
  expect(document.body.textContent).toContain("退款支出");
});
