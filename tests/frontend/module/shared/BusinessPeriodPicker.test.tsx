import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BusinessPeriodPicker } from "@/shared/ui/BusinessPeriodPicker";
import type { PeriodState } from "@/shared/state/businessPeriod";

function state(ready = true): PeriodState {
  return { period: { from: "2026-11-16", to: "2026-12-15" }, startDay: 16, ready, error: null,
    retry: vi.fn(), setPeriod: vi.fn(), useCurrentPeriod: vi.fn(), usePreviousPeriod: vi.fn(), useAllPeriods: vi.fn() };
}

describe("日期快捷筛选", () => {
  it("支持使用 Enter 和空格切换日期", async () => {
    const period = state();
    const user = userEvent.setup();
    render(<BusinessPeriodPicker state={period} showAll />);
    screen.getByRole("button", { name: "本期" }).focus();
    await user.keyboard("{Enter}");
    screen.getByRole("button", { name: "上期" }).focus();
    await user.keyboard(" ");
    screen.getByRole("button", { name: "全部" }).focus();
    await user.keyboard("{Enter}");
    expect(period.useCurrentPeriod).toHaveBeenCalledOnce();
    expect(period.usePreviousPeriod).toHaveBeenCalledOnce();
    expect(period.useAllPeriods).toHaveBeenCalledOnce();
  });
  it("日期配置未就绪时禁用快捷操作", () => {
    render(<BusinessPeriodPicker state={state(false)} showAll />);
    expect(screen.getByRole("button", { name: "本期" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "上期" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "全部" })).toBeDisabled();
  });
});
