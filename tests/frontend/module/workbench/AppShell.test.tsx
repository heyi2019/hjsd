import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "@/shared/api/catalog";
vi.mock("@/shared/api/catalog");
import { renderApp } from "@fixtures/render";
import { AppShell } from "@/app/AppShell";
import { navigation } from "@/app/navigation";
import { MemoryRouter } from "react-router-dom";

let ui: ReturnType<typeof userEvent.setup>;

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
    "reportsApi",
    "auditApi",
    "importsApi",
    "policyApi",
  ]);
  return { deepStub, OBJECT_SHAPED };
});



vi.mock("@/auth/UserCenterPage", () => ({
  UserCenterPage: () => <div>用户中心内容</div>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(catalog)) {
    if (!key.endsWith("Api")) continue;
    const apiObj = (catalog as Record<string, unknown>)[key] as Record<string, unknown>;
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
  vi.mocked(catalog.cashflowsApi.list).mockResolvedValue({ items: [], total: 0 });
});

async function renderShell(options: { user?: string; initialPath?: string } = {}) {
  const { initialPath = "/dashboard", ...rest } = options;
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
    expect(nav.querySelector('[data-nav-key="dashboard"]')).toHaveAttribute("data-mobile-order", "3");
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
  it("工作台个人卡片提供我的订单和我的收益入口，并进入对应业务视图", async () => {
    await renderShell({ user: "admin" });
    const topbar = document.querySelector(".topbar") as HTMLElement;
    const dashboard = document.querySelector(".dashboard-page") as HTMLElement;

    expect(within(topbar).queryByRole("button", { name: "我的订单" })).toBeNull();
    expect(within(topbar).queryByRole("button", { name: "我的收益" })).toBeNull();

    await ui.click(within(dashboard).getByRole("button", { name: /我的订单/ }));
    expect(await screen.findByRole("tab", { name: "订单台账" })).toHaveAttribute("aria-selected", "true");
    expect(vi.mocked(catalog.ordersApi.list)).toHaveBeenCalledWith({ mine: true });

    await ui.click(screen.getByRole("button", { name: "工作台" }));
    await ui.click(screen.getByRole("button", { name: /我的收益/ }));
    const commissionTab = await screen.findByRole("tab", { name: "提成对账 R3" });
    expect(commissionTab).toHaveAttribute("aria-selected", "true");
    expect(vi.mocked(catalog.reportsApi.commission)).toHaveBeenCalledWith({ mine: true });
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
