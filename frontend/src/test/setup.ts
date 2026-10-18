// vitest 入口会同时注册 matchers 并扩展 expect 的类型（jest-dom v7 提供 vitest.d.ts）
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { resetTestBrowserState } from "./browser-state";

afterEach(() => {
  cleanup();
  resetTestBrowserState();
  // antd 浮动层（Select/Modal/message/notification/Drawer/Popover/Tooltip/DatePicker 等）
  // 渲染到 document.body 而非 RTL container，cleanup() 只卸 RTL 容器；isolate:false 下
  // jsdom 跨文件复用时这些残留节点会干扰后续用例（如弹窗下拉选项查询超时）。此处兜底
  // 清空 body 全部子节点——等价于 isolate:true 每次重建 document 的效果，对所有 portal 类型通用。
  while (document.body.firstElementChild) {
    document.body.removeChild(document.body.firstElementChild);
  }
});

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
