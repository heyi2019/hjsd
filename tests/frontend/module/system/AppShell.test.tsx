import { counterpartiesApi, customersApi, leadsApi } from "@/shared/api/customers.api";
import { depositsApi } from "@/shared/api/deposits.api";
import { installmentsApi } from "@/shared/api/installments.api";
import { attachmentsApi, gameTypesApi, sequencesApi } from "@/shared/api/misc.api";
import { notificationsApi } from "@/shared/api/notifications.api";
import { optionSetsApi } from "@/shared/api/options.api";
import { listColumnsApi, orderFormFieldsApi, orderTypesApi } from "@/shared/api/orders.api";
import { employeesApi, teamsApi, usersApi } from "@/shared/api/org.api";
import { profitAllocationApi } from "@/shared/api/profitAllocation.api";
import { poolsApi } from "@/shared/api/pools.api";
import { reconciliationsApi } from "@/shared/api/reconciliations.api";
import { transfersApi } from "@/shared/api/transfers.api";
import { rebatesApi } from "@/shared/api/rebates.api";
import { auditApi } from "@/shared/api/reports.api";
import { stocksApi } from "@/shared/api/stocks.api";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cashflowsApi } from "@/shared/api/cashflows.api";
import { orderCashflowsApi } from "@/shared/api/orderCashflows.api";
import { ordersApi } from "@/shared/api/orders.api";
import { reportsApi } from "@/shared/api/reports.api";
import { workbenchApi } from "@/shared/api/workbench.api";
vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/workbench.api");
vi.mock("@/shared/api/orderCashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/deposits.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/notifications.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/profitAllocation.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/reconciliations.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");
vi.mock("@/shared/api/transfers.api");
import { renderApp } from "@fixtures/render";
import { cashflowPage, customerSummary, workbenchSummary, installmentTotals, orderLedgerSummary, pageResponse } from "@fixtures/api-responses";
import { AppShell } from "@/app/AppShell";
import { navigation } from "@/app/navigation";
import { MemoryRouter } from "react-router-dom";
import dayjs from "dayjs";
import { currentReportPeriod, previousReportPeriod } from "@/reporting/reportPeriod";
import { setAntdDateRange } from "@fixtures/antdRange";

let ui: ReturnType<typeof userEvent.setup>;

const __allApi = { workbenchApi, cashflowsApi, orderCashflowsApi, counterpartiesApi, customersApi, leadsApi, depositsApi, installmentsApi, attachmentsApi, gameTypesApi, notificationsApi, sequencesApi, optionSetsApi, listColumnsApi, orderFormFieldsApi, orderTypesApi, ordersApi, employeesApi, teamsApi, usersApi, profitAllocationApi, poolsApi, reconciliationsApi, transfersApi, rebatesApi, auditApi, reportsApi, stocksApi };

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

/** 把 catalog 里所有 *Api 的方法统一桩掉：默认返回空数组，个别接口在用例里覆盖。
 *  目的：让「导航可达性」测试不依赖后端，只验证页面能挂载、不崩、标题正确。 */
/** vi.mock 会被提升到文件顶部，工厂里用到的变量必须用 vi.hoisted 定义，
 *  否则报 "Cannot access ... before initialization"。 */
const { deepStub, OBJECT_SHAPED } = vi.hoisted(() => {
  /** 深兜底对象：报表/余额类接口返回嵌套结构（total.income 等），
   *  导航测试只关心「页面能否挂载」，不关心数值，故让任意属性访问都返回安全值。 */
  function deepStub(): unknown {
  const target = function () {} as unknown as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "toString") return () => "0";
      if (prop === "valueOf") return () => 0;
      if (prop === "length") return 0;
      if (prop === "map" || prop === "filter" || prop === "slice") return () => [];
      if (prop === "reduce") return (_fn: unknown, init: unknown) => init ?? 0;
      if (prop === "forEach") return () => undefined;
      if (prop === "some" || prop === "every") return () => false;
      if (prop === "toFixed") return () => "0.00";
      if (prop === "items" || prop === "rows" || prop === "list" || prop === "data") return [];
      return deepStub();
    },
  });
  }

  /** 返回对象而非数组的接口：其余一律 []（列表类）。 */
  const OBJECT_SHAPED = new Set([
    "workbenchApi",
    "reportsApi",
    "auditApi",
    "profitAllocationApi",
  ]);
  return { deepStub, OBJECT_SHAPED };
});



vi.mock("@/auth/UserCenterPage", () => ({
  UserCenterPage: () => <div>用户中心内容</div>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(__allApi)) {
    if (!key.endsWith("Api")) continue;
    const apiObj = (__allApi as Record<string, unknown>)[key] as Record<string, unknown>;
    if (!apiObj || typeof apiObj !== "object") continue;
    for (const method of Object.keys(apiObj)) {
      const fn = (apiObj as Record<string, unknown>)[method];
      if (fn && typeof (fn as { mockResolvedValue?: unknown }).mockResolvedValue === "function") {
        const isObjectShaped = OBJECT_SHAPED.has(key) || method === "balance";
        (fn as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(
          isObjectShaped ? deepStub() : [],
        );
      }
    }
  }
  // 资金流水接口返回分页包裹体（items/total），与 Batch 2 后 FundsPage 的消费方式对齐；
  // 通用兜底只给 []，会导致 response.items 为 undefined 进而 .filter 崩溃。
  vi.mocked(cashflowsApi.list).mockResolvedValue(cashflowPage([]));
  // 订单台账读取接口返回分页/汇总对象，避免从工作台进入“我的当期订单”时被通用空数组桩破坏响应契约。
  vi.mocked(ordersApi.listPage).mockResolvedValue(pageResponse([]));
  vi.mocked(ordersApi.ledgerSummary).mockResolvedValue(orderLedgerSummary());
  vi.mocked(orderTypesApi.list).mockResolvedValue([]);
  vi.mocked(workbenchApi.summary).mockImplementation(async (period) => workbenchSummary(period ? { period } : {}));
  vi.mocked(customersApi.page).mockResolvedValue(pageResponse([]));
  vi.mocked(customersApi.summary).mockResolvedValue(customerSummary());
  vi.mocked(counterpartiesApi.page).mockResolvedValue(pageResponse([]));
  vi.mocked(leadsApi.page).mockResolvedValue(pageResponse([]));
  vi.mocked(leadsApi.summary).mockResolvedValue({ total_count: 0, open_count: 0 });
  vi.mocked(installmentsApi.page).mockResolvedValue(pageResponse([]));
  vi.mocked(installmentsApi.totals).mockResolvedValue(installmentTotals());
  vi.mocked(optionSetsApi.get).mockImplementation(async (code) => code === "BUSINESS_PERIOD"
    ? { code, options: [{ value: "start_day", label: "16" }] } as never
    : [] as never);
});

async function renderShell(options: { user?: string; initialPath?: string } = {}) {
  const { initialPath = "/workbench", ...rest } = options;
  await act(async () => {
    renderApp(
      <MemoryRouter initialEntries={[initialPath]}>
        <AppShell />
      </MemoryRouter>,
      rest,
    );
    await Promise.resolve();
  });
}

describe("AppShell：导航可达性（页签 ↔ 页面一一对应）", () => {
  it("从客户中心直接进入时不加载未访问的工作台，首次进入工作台再预热", async () => {
    await renderShell({ user: "admin", initialPath: "/customers" });
    await screen.findByRole("tab", { name: "客户档案" });
    expect(document.querySelector(".workbench-page")).toBeNull();
    expect(poolsApi.list).not.toHaveBeenCalled();
    expect(gameTypesApi.list).not.toHaveBeenCalled();
    await ui.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "工作台" }));
    expect(await screen.findByText("今天从这里开始")).toBeVisible();
    await waitFor(() => expect(poolsApi.list).toHaveBeenCalled());
    expect(gameTypesApi.list).toHaveBeenCalled();
  });

  it("侧栏渲染全部导航入口（限定在 nav 内，避开页面同名按钮）", async () => {
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const labels = [...nav.querySelectorAll(".nav-item")].map((b) => b.textContent?.trim());
    for (const item of navigation) {
      expect(labels.some((l) => l?.includes(item.label))).toBe(true);
    }
    expect(nav.querySelectorAll(".nav-item").length).toBe(navigation.length);
  });

  it("移动端底部入口顺序为业务、客户、工作台、资金、管理", async () => {
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "主导航" });

    expect(
      [...nav.querySelectorAll<HTMLElement>("[data-mobile-order]")]
        .map((item) => item.dataset.mobileOrder)
        .sort(),
    ).toEqual(["1", "2", "3", "4", "5"]);
    expect(nav.querySelector('[data-nav-key="business"]')).toHaveAttribute("data-mobile-order", "1");
    expect(nav.querySelector('[data-nav-key="customers"]')).toHaveAttribute("data-mobile-order", "2");
    expect(nav.querySelector('[data-nav-key="workbench"]')).toHaveAttribute("data-mobile-order", "3");
    expect(nav.querySelector('[data-nav-key="funds"]')).toHaveAttribute("data-mobile-order", "4");
    expect(nav.querySelector(".mobile-more-button")).toHaveAttribute("data-mobile-order", "5");
  });

  it("默认落工作台，标题区显示当前页名", async () => {
    await renderShell();
    expect(document.querySelector(".topbar__page")?.textContent).toBe("工作台");
  });

  it("点击左侧业务中心默认打开库存中心", async () => {
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    await ui.click(within(nav).getByRole("button", { name: "业务中心" }));

    const inventoryTab = await screen.findByRole("tab", { name: "库存中心" }, { timeout: 10_000 });
    expect(inventoryTab).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "业务总览" })).toBeNull();
    expect(screen.getByRole("tab", { name: "订单台账" })).toHaveAttribute("aria-selected", "false");
  });

  it("逐个点击每个导航项都能切换到对应页面（无白屏、无抛错）", async () => {
    await renderShell();
    for (const item of navigation) {
      const nav = screen.getByRole("navigation", { name: "主导航" });
      const target = [...nav.querySelectorAll(".nav-item")].find((b) =>
        b.textContent?.includes(item.label),
      ) as Element;
      await ui.click(target);
      await waitFor(() =>
        expect(document.querySelector(".topbar__page")?.textContent).toBe(item.label),
        { timeout: 10_000 },
      );
      // 页面自身标题（h2）也要对上：顶栏与页头同名，故用 All 变体
      expect(screen.getAllByRole("heading", { name: item.label }).length).toBeGreaterThanOrEqual(1);
      // 高亮态随之切换
      const active = document.querySelector(".nav-item--active");
      expect(active?.textContent).toContain(item.label);
      expect(within(nav).getByText(item.label)).toBeTruthy();
    }
    expect(document.querySelectorAll(".page-error-boundary")).toHaveLength(0);
  });

  it("当前页签带 aria-current=page", async () => {
    await renderShell();
    const current = document.querySelector('[aria-current="page"]');
    expect(current?.textContent).toContain("工作台");
  });

  it("空路径 '/' 重定向到工作台（URL 决定落点）", async () => {
    await renderShell({ initialPath: "/" });
    await waitFor(() =>
      expect(document.querySelector(".topbar__page")?.textContent).toBe("工作台"),
    );
  });

  it("业务中心 URL 带 tab 段时深链到对应子页（库存中心）", async () => {
    await renderShell({ initialPath: "/business/inventory" });
    const inventoryTab = await screen.findByRole("tab", { name: "库存中心" });
    expect(inventoryTab).toHaveAttribute("aria-selected", "true");
  });
});

describe("AppShell：角色展示与退出", () => {
  it("工作台全部时间统计与客户、收益明细保持一致", async () => {
    vi.mocked(workbenchApi.summary).mockImplementation(async (period) => workbenchSummary({ period: (period === null ? null : period ?? currentReportPeriod()) as never }));
    await renderShell({ user: "admin" });
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenCalled());
    await ui.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenLastCalledWith(null));
    const orderCard = screen.getByTestId("workbench-personal-orders");
    await waitFor(() => expect(orderCard).toHaveAttribute("role", "button"));
    await ui.click(screen.getByTestId("workbench-personal-customers"));
    await waitFor(() => expect(customersApi.page).toHaveBeenCalledWith(expect.objectContaining({ mine_orders: true })));
    expect(await screen.findByText(/订单操作人：.*全部时间/)).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: "工作台" }));
    await waitFor(() => expect(screen.getByTestId("workbench-personal-earnings")).toHaveAttribute("role", "button"));
    await ui.click(screen.getByTestId("workbench-personal-earnings"));
    await waitFor(() => expect(reportsApi.commission).toHaveBeenCalledWith(expect.objectContaining({ mine: true })));
    expect(vi.mocked(reportsApi.commission).mock.lastCall?.[0]).not.toHaveProperty("from");
    expect(vi.mocked(reportsApi.commission).mock.lastCall?.[0]).not.toHaveProperty("to");
    await ui.click(screen.getByRole("button", { name: "本期" }));
    await waitFor(() => expect(reportsApi.commission).toHaveBeenLastCalledWith(expect.objectContaining({ mine: true, ...currentReportPeriod() })));
    await ui.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(vi.mocked(reportsApi.commission).mock.lastCall?.[0]).not.toHaveProperty("from"));
    await ui.click(screen.getByRole("button", { name: "工作台" }));
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenLastCalledWith(null));
  });

  it("我的当期客户跳转展示本人和周期，并按订单口径筛选", async () => {
    vi.mocked(employeesApi.list).mockResolvedValue([{ id: 1, username: "admin", display_name: "管理员姓名", is_active: true }] as never);
    await renderShell({ user: "admin", initialPath: "/customers?mine_orders=true&trade_date_from=2026-11-16&trade_date_to=2026-12-15" });
    await waitFor(() => expect(customersApi.page).toHaveBeenCalledWith(expect.objectContaining({ mine_orders: true, trade_date_from: "2026-11-16", trade_date_to: "2026-12-15" })));
    expect(customersApi.summary).toHaveBeenCalledWith(expect.objectContaining({ mine_orders: true, trade_date_from: "2026-11-16", trade_date_to: "2026-12-15" }));
    expect(await screen.findByText(/管理员姓名.*2026-11-16.*2026-12-15/)).toBeInTheDocument();
    expect(vi.mocked(customersApi.page).mock.lastCall?.[0]).not.toHaveProperty("created_from");
    await ui.click(screen.getByRole("button", { name: "本期" }));
    await waitFor(() => expect(customersApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ created_from: currentReportPeriod().from, created_to: currentReportPeriod().to, mine_orders: true })));
    await ui.click(screen.getByRole("button", { name: "清除订单筛选" }));
    await waitFor(() => expect(customersApi.page).toHaveBeenLastCalledWith(expect.not.objectContaining({ mine_orders: true })));
    expect(screen.queryByText(/管理员姓名.*2026-11-16.*2026-12-15/)).toBeNull();
  });

  it("客户中心的创建日期快捷筛选应用于客户、合作方和需求", async () => {
    await renderShell({ user: "admin", initialPath: "/customers" });
    expect((await screen.findByRole("button", { name: "上期" })).closest(".customer-list-filters")).not.toBeNull();
    await ui.click(await screen.findByRole("button", { name: "上期" }));
    const previous = previousReportPeriod();
    await waitFor(() => expect(customersApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ created_from: previous.from, created_to: previous.to })));
    await setAntdDateRange(screen.getByRole("tabpanel"), ui, "2026-01-02", "2026-02-03");
    await waitFor(() => expect(customersApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ created_from: "2026-01-02", created_to: "2026-02-03" })));
    await ui.click(screen.getByRole("tab", { name: "合作方（同行/供货方/平台）" }));
    expect(screen.getByRole("button", { name: "上期" }).closest(".counterparty-filter-bar")).not.toBeNull();
    await waitFor(() => expect(counterpartiesApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ created_from: "2026-01-02", created_to: "2026-02-03" })));
    await ui.click(screen.getByRole("tab", { name: "客户需求池" }));
    await waitFor(() => expect(leadsApi.page).toHaveBeenLastCalledWith(expect.objectContaining({ created_from: "2026-01-02", created_to: "2026-02-03" })));
    await ui.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(vi.mocked(leadsApi.page).mock.lastCall?.[0]).not.toHaveProperty("created_from"));
  });

  it("工作台与经营中心共用已配置的周期和临时日期选择", async () => {
    vi.mocked(optionSetsApi.get).mockResolvedValue({ code: "BUSINESS_PERIOD", options: [{ value: "start_day", label: "10" }] } as never);
    await renderShell({ user: "admin" });
    const workbench = document.querySelector(".workbench-page") as HTMLElement;
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenCalledWith(currentReportPeriod(dayjs(), 10)));
    await ui.click(within(workbench).getByRole("button", { name: "上期" }));
    const previous = previousReportPeriod(dayjs(), 10);
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenLastCalledWith(previous));
    const nav = screen.getByRole("navigation", { name: "主导航" });
    await ui.click(within(nav).getByRole("button", { name: "经营中心" }));
    await waitFor(() => expect(reportsApi.monthlyPnl).toHaveBeenCalledWith(previous));
    await ui.click(screen.getByRole("button", { name: "本期" }));
    await ui.click(within(nav).getByRole("button", { name: "工作台" }));
    await waitFor(() => expect(workbenchApi.summary).toHaveBeenLastCalledWith(currentReportPeriod(dayjs(), 10)));
  });

  it("工作台个人卡片提供我的当期订单和我的当期收益入口，并进入对应业务视图", async () => {
    await renderShell({ user: "admin" });
    const topbar = document.querySelector(".topbar") as HTMLElement;
    const workbench = document.querySelector(".workbench-page") as HTMLElement;

    expect(within(topbar).queryByRole("button", { name: "我的当期订单" })).toBeNull();
    expect(within(topbar).queryByRole("button", { name: "我的当期收益" })).toBeNull();

    await waitFor(() => expect(within(workbench).getByTestId("workbench-personal-orders")).toHaveAttribute("role", "button"));
    await ui.click(within(workbench).getByTestId("workbench-personal-orders"));
    expect(await screen.findByRole("tab", { name: "订单台账" })).toHaveAttribute("aria-selected", "true");
    expect(vi.mocked(ordersApi.listPage)).toHaveBeenCalledWith(expect.objectContaining({ mine: true }));

    await ui.click(screen.getByRole("button", { name: "工作台" }));
    await waitFor(() => expect(screen.getByTestId("workbench-personal-earnings")).toHaveAttribute("role", "button"));
    await ui.click(screen.getByTestId("workbench-personal-earnings"));
    const commissionTab = await screen.findByRole("tab", { name: "分润对账" });
    expect(commissionTab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(vi.mocked(reportsApi.commission)).toHaveBeenCalledWith(expect.objectContaining({ mine: true })));
  });

  it("顶栏用户中心入口可打开弹窗", async () => {
    await renderShell({ user: "admin" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await ui.click(screen.getByRole("button", { name: "用户中心" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("用户中心内容")).toBeInTheDocument();
  });

  it("顶栏角色为只读文本（管理员配置，无下拉选择器）", async () => {
    await renderShell({ user: "admin" });
    const topbar = document.querySelector(".topbar") as HTMLElement;
    expect(within(topbar).getByText("当前角色（开发态）")).toBeTruthy();
    expect(within(topbar).getByText("系统管理员")).toBeTruthy();
    // 角色不是运行时可选参数：顶栏不得出现任何 antd 选择器
    expect(topbar.querySelector(".ant-select-selector")).toBeNull();
  });

  it("DEV 态顶栏也常驻退出登录按钮", async () => {
    await renderShell({ user: "admin" });
    const topbar = document.querySelector(".topbar") as HTMLElement;
    // 用可访问名精确断言：rc-motion 测试桩若忽略 visible，antd Button 会渲染 loading 图标
    // 把 name 污染成「loading 退出登录」，此断言即失败（回归护栏）。
    expect(within(topbar).getByRole("button", { name: "退出登录" })).toBeTruthy();
  });
});
