import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppearancePanel } from "./AppearancePanel";
import { renderApp } from "../test/render";
import { GLASS_DEFAULT, GLASS_MAX, GLASS_MIN } from "../shared/state/glass";

describe("AppearancePanel：玻璃材质透明度滑桿", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("默认渲染滑桿，范围正确", () => {
    renderApp(<AppearancePanel />);
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("aria-valuemin", String(GLASS_MIN));
    expect(slider).toHaveAttribute("aria-valuemax", String(GLASS_MAX));
    expect(slider).toHaveAttribute("aria-valuenow", String(GLASS_DEFAULT));
  });

  it("拖动滑桿调用 setAlpha 并写回 localStorage", () => {
    renderApp(<AppearancePanel />);
    const slider = screen.getByRole("slider");
    // rc-slider 的 onKeyDown 走 e.which/keyCode（Home=36），jsdom 的 fireEvent 默认不填，需显式补。
    fireEvent.keyDown(slider, { key: "Home", keyCode: 36, which: 36 });
    expect(localStorage.getItem("heijin-glass-alpha")).toBe(String(GLASS_MIN));
  });

  it("系统开启降低透明度时显示强制实底提示", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    renderApp(<AppearancePanel />);
    expect(screen.getByText(/强制为不透明实底/)).toBeInTheDocument();
  });
});
