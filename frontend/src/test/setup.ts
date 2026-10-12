// vitest 入口会同时注册 matchers 并扩展 expect 的类型（jest-dom v7 提供 vitest.d.ts）
import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom polyfills for APIs antd v5 touches during render/unmount.

// matchMedia (antd Grid / responsive hooks call this)
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// ResizeObserver global (rc-resize-observer via rc-table)
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
global.ResizeObserver = global.ResizeObserver || ResizeObserverStub;

// getComputedStyle pseudo-element handling (some antd measurement code paths)
if (typeof window.getComputedStyle === "function") {
  const original = window.getComputedStyle.bind(window);
  // 固定长度签名：变长 `...args: any[]` 在 tsconfig types 缺失时会触发 TS2556。
  window.getComputedStyle = ((elt: Element, _pseudoElt?: string | null) => {
    // jsdom 26 intentionally throws for pseudo-elements; antd only needs the
    // computed style object for measurements in these tests.
    const style = original(elt);
    if (style && typeof (style as any).getPropertyValue !== "function") {
      (style as any).getPropertyValue = () => "";
    }
    return style;
  }) as typeof window.getComputedStyle;
}
