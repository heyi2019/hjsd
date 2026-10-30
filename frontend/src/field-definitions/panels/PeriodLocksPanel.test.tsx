/** PeriodLocksPanel 测试：列表渲染、新建成功刷新、格式校验、弹窗内错误可见、无权限隐藏写按钮。
 *
 * 断言要点：
 * - 按钮一律用**正则**匹配名字：antd Button 内部恒有无障碍图标节点（aria-label="loading"），
 *   精确串匹配会因子串拼接失败；
 * - 表格「—」占位要锁定到具体单元格：一行里 locked_at 与 note 都可能渲染「—」。
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";
import { PeriodLocksPanel } from "./PeriodLocksPanel";
import * as catalog from "../../shared/api/catalog";

let ui: ReturnType<typeof userEvent.setup>;

// 用「spread 真模块 + 逐个方法 vi.fn()」的工厂：裸 automock 会让组件侧与测试侧引用发散。
vi.mock("../../shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/api/catalog")>();
  const METHODS = ["list", "create", "get", "patch", "post", "remove"];
  const mk = (api: Record<string, unknown>) => {
    const o: Record<string, unknown> = { ...api };
    for (const m of METHODS) {
      if (m in o) o[m] = vi.fn();
    }
    return o;
  };
  const out: Record<string, unknown> = { ...actual };
  for (const key of Object.keys(actual)) {
    const value = (actual as Record<string, unknown>)[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = mk(value as Record<string, unknown>);
    }
  }
  return out as unknown as typeof actual;
});

const locks = [
  { id: 1, period: "2026-09", locked_at: "2026-10-01T09:30:00", locked_by: "heyi", note: "9月封账" },
  { id: 2, period: "2026-10", locked_at: null, locked_by: "admin", note: null },
] as unknown as catalog.PeriodLock[];

const cellText = (rowLabel: string, index: number): string => {
  const row = screen.getByText(rowLabel).closest("tr") as HTMLElement;
  return (row.querySelectorAll("td")[index]?.textContent ?? "").trim();
};

const openModal = async () => {
  await ui.click(screen.getByRole("button", { name: /锁定账期/ }));
  return screen.findByRole("dialog");
};

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(catalog.periodLocksApi.list).mockResolvedValue(locks);
  vi.mocked(catalog.periodLocksApi.create).mockResolvedValue(locks[0]);
});

describe("PeriodLocksPanel", () => {
  it("渲染已锁账期，空值回退为占位符", async () => {
    renderLight(<PeriodLocksPanel />, { user: "admin" });

    expect(await screen.findByText("2026-09")).toBeTruthy();
    expect(screen.getByText("2026-10-01 09:30")).toBeTruthy();
    expect(screen.getByText("heyi")).toBeTruthy();
    expect(cellText("2026-09", 3)).toBe("9月封账");
    // locked_at / note 为空不能渲染 Invalid Date 或空白
    expect(cellText("2026-10", 1)).toBe("—");
    expect(cellText("2026-10", 3)).toBe("—");
    expect(screen.queryByText("Invalid Date")).toBeNull();
  });

  it("提交后调用 create 并刷新列表", async () => {
    renderLight(<PeriodLocksPanel />, { user: "admin" });
    const modal = await openModal();

    const period = within(modal).getByLabelText("会计账期") as HTMLInputElement;
    // 会计账期已改为原生年月选择器（input[type=month]），值恒为 "YYYY-MM" 字符串。
    expect(period).toHaveAttribute("type", "month");
    fireEvent.change(period, { target: { value: "2026-11" } });
    fireEvent.change(within(modal).getByLabelText("说明"), { target: { value: "11月封账" } });
    await ui.click(within(modal).getByRole("button", { name: /确认锁定/ }));

    await waitFor(() =>
      expect(catalog.periodLocksApi.create).toHaveBeenCalledWith({
        period: "2026-11",
        note: "11月封账",
      }),
    );
    await waitFor(() => expect(catalog.periodLocksApi.list).toHaveBeenCalledTimes(2));
  });

  it("账期为空时不发起 create 并提示必填", async () => {
    renderLight(<PeriodLocksPanel />, { user: "admin" });
    const modal = await openModal();

    // 原生年月选择器（input[type=month]）由浏览器约束为 YYYY-MM，空值走必填校验。
    const input = within(modal).getByLabelText("会计账期") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    await ui.click(within(modal).getByRole("button", { name: /确认锁定/ }));

    expect(catalog.periodLocksApi.create).not.toHaveBeenCalled();
    expect(await within(modal).findByText(/Please enter|必填|请输入|不能为空/)).toBeTruthy();
  });

  it("create 失败时错误显示在弹窗内，不吞掉", async () => {
    vi.mocked(catalog.periodLocksApi.create).mockRejectedValue(new Error("账期已锁定"));
    renderLight(<PeriodLocksPanel />, { user: "admin" });
    const modal = await openModal();

    await ui.click(within(modal).getByRole("button", { name: /确认锁定/ }));

    expect(await within(modal).findByRole("alert")).toBeTruthy();
    // 非 axios 错误经 normalizeError 变成 String(err)，因此用子串匹配而非精确串
    expect(within(modal).getByText(/账期已锁定/)).toBeTruthy();
  });

  it("无 finance.period.lock 权限时隐藏锁定按钮", async () => {
    renderLight(<PeriodLocksPanel />, { user: "operator" });

    expect(await screen.findByText("2026-09")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /锁定账期/ })).toBeNull();
  });
});
