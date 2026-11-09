import { screen, waitFor, within, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as catalog from "@/shared/api/catalog";
vi.mock("@/shared/api/catalog");
import { renderApp } from "@fixtures/render";
import { AppShell } from "@/app/AppShell";
import { MemoryRouter } from "react-router-dom";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

afterEach(() => {
  cleanup();
  // antd Modal / Popconfirm portal 渲染在 body 下，cleanup 不覆盖，需手动清防残留
  document.body
    .querySelectorAll('[class*="ant-modal"], [class*="ant-popconfirm"]')
    .forEach((el) => el.remove());
  localStorage.clear();
});

/** catalog 深兜底：让子页面（OrdersPage/FundsPage/... lazy 加载）在导航切换时不依赖后端、只验证 AppShell 自身分支。 */
const { deepStub, OBJECT_SHAPED } = vi.hoisted(() => {
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
  const OBJECT_SHAPED = new Set(["reportsApi", "auditApi", "policyApi"]);
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

describe("AppShell：主题三态切换", () => {
  it("点系统/浅色/深色分别写入 localStorage 且对应按钮激活", async () => {
    await renderShell({ user: "admin" });
    const sys = () => screen.getByRole("radio", { name: /系统/ });
    const light = () => screen.getByRole("radio", { name: /浅色/ });
    const dark = () => screen.getByRole("radio", { name: /深色/ });

    await ui.click(light());
    expect(localStorage.getItem("heijin-theme-mode")).toBe("light");
    expect(light().className).toContain("is-active");
    expect(dark().className).not.toContain("is-active");

    await ui.click(dark());
    expect(localStorage.getItem("heijin-theme-mode")).toBe("dark");
    expect(dark().className).toContain("is-active");
    expect(light().className).not.toContain("is-active");

    await ui.click(sys());
    expect(localStorage.getItem("heijin-theme-mode")).toBe("system");
    expect(sys().className).toContain("is-active");
  });

  it("主题三态以互斥单选语义暴露给辅助技术且默认浅色", async () => {
    await renderShell({ user: "admin" });

    expect(screen.getByRole("radiogroup", { name: "主题切换" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "系统" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "浅色（默认）" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "深色" })).toHaveAttribute("aria-checked", "false");
  });
});

describe("AppShell：⌘/Ctrl+K 快捷键", () => {
  it("⌘K（或 Ctrl+K）跳业务中心并定位到库存中心子页", async () => {
    await renderShell({ user: "admin" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    // AppShell loads the business page through React.lazy.  Under the full CI
    // suite the deep and regular React projects run concurrently, so the
    // initial module transform can legitimately take longer than Testing
    // Library's 1s default query timeout.  Keep the assertion bounded while
    // allowing the real lazy page to finish loading.
    const inventoryTab = await screen.findByRole("tab", { name: "库存中心" }, { timeout: 10_000 });
    expect(inventoryTab).toHaveAttribute("aria-selected", "true");

    // 再回到工作台，验证 Ctrl+K 同样生效。
    await ui.click(screen.getByRole("button", { name: /工作台/ }));
    await waitFor(() =>
      expect(document.querySelector(".topbar__page")?.textContent).toBe("工作台"),
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const inventoryTab2 = await screen.findByRole("tab", { name: "库存中心" }, { timeout: 10_000 });
    expect(inventoryTab2).toHaveAttribute("aria-selected", "true");
  });
});

describe("AppShell：「管理」Modal（窄屏二级导航）", () => {
  it("打开后含经营中心/设置/用户中心菜单项，点经营中心关闭并切换激活", async () => {
    await renderShell({ user: "admin" });
    await ui.click(screen.getByRole("button", { name: "更多导航" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("menuitem", { name: /经营中心/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("menuitem", { name: /设置/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("menuitem", { name: /用户中心/ })).toBeInTheDocument();

    await ui.click(within(dialog).getByRole("menuitem", { name: /经营中心/ }));
    // 点击后应导航到经营中心（Modal 关闭由 antd 处理，其标题文本关闭后仍留 DOM，故断言导航切换）
    await waitFor(() =>
      expect(document.querySelector(".nav-item--active")?.textContent).toContain("经营中心"),
    );
  });

  it("从「管理」Modal 点用户中心可打开用户中心弹窗", async () => {
    await renderShell({ user: "admin" });
    await ui.click(screen.getByRole("button", { name: "更多导航" }));
    const dialog = await screen.findByRole("dialog");
    await ui.click(within(dialog).getByRole("menuitem", { name: /用户中心/ }));
    expect(await screen.findByText("用户中心内容")).toBeInTheDocument();
  });
});

describe("AppShell：退出登录", () => {
  it("点退出登录弹出确认，确认后落登录页", async () => {
    await renderShell({ user: "admin" });
    await ui.click(screen.getByRole("button", { name: "退出登录" }));
    const desc = await screen.findByText("退出后需要重新登录才能继续操作。");
    const popconfirm = desc.closest(".ant-popconfirm") as HTMLElement;
    await ui.click(within(popconfirm).getByRole("button", { name: /退出/ }));
    expect(await screen.findByText("登录工作台")).toBeInTheDocument();
  });
});

describe("AppShell：业务中心首页落点", () => {
  it("深链到订单台账子页，切走再切回进入库存中心首页", async () => {
    await renderShell({ user: "admin", initialPath: "/business/orders" });
    const ordersTab = await screen.findByRole("tab", { name: "订单台账" });
    expect(ordersTab).toHaveAttribute("aria-selected", "true");

    // 切到工作台并确认当前页标题更新。
    await ui.click(screen.getByRole("button", { name: /工作台/ }));
    await waitFor(() =>
      expect(document.querySelector(".topbar__page")?.textContent).toBe("工作台"),
    );

    // 再点业务中心（不指定子页）→ 应进入库存中心首页
    await ui.click(screen.getByRole("button", { name: /业务中心/ }));
    const inventoryTab = await screen.findByRole("tab", { name: "库存中心" });
    expect(inventoryTab).toHaveAttribute("aria-selected", "true");
  });
});
