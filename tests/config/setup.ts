// vitest 入口会同时注册 matchers 并扩展 expect 的类型（jest-dom v7 提供 vitest.d.ts）
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { resetTestBrowserState } from "@fixtures/browser-state";

afterEach(async () => {
  // 清空所有 mock 的调用记录与一次性返回值队列（mockResolvedValueOnce 等），
  // 为后续启用 isolate:false 复用模块图扫清 mock 共享泄漏；配合各文件 beforeEach 重新设定返回值。
  vi.resetAllMocks();
  // resetAllMocks 会清掉下面 setup 里 window.matchMedia 这个 vi.fn() 桩，必须重建，
  // 否则 antd responsiveObserver 调用 matchMedia(...).matches 直接崩溃。
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
  cleanup();
  resetTestBrowserState();
  // antd 浮动层（Select/Modal/message/notification/Drawer/Popover/Tooltip/DatePicker 等）
  // 渲染到 document.body 而非 RTL container，cleanup() 只卸 RTL 容器；isolate:false 下
  // jsdom 跨文件复用时这些残留节点会干扰后续用例（如弹窗下拉选项查询超时）。此处兜底
  // 清空 body 全部子节点——等价于 isolate:true 每次重建 document 的效果，对所有 portal 类型通用。
  while (document.body.firstElementChild) {
    document.body.removeChild(document.body.firstElementChild);
  }
  // antd Table/rc-overflow schedules a MessageChannel update after unmount.
  // Let that task drain while jsdom is still alive; otherwise the callback can
  // run after the test environment is torn down and raise `window is not defined`.
  //
  // 单次 setTimeout(0) 只让出「一个」宏任务，挡不住 React 18+ 的并发渲染：
  // 用例里未 await 的异步 setState 会走 scheduler 的 MessageChannel，在负载高时
  // 排到本次 tick 之后；jsdom 一拆除，commit 阶段就抛 `window is not defined` /
  // `document global ... is not defined anymore`。Vitest 把它记为 unhandled error，
  // 于是「80 文件 / 970 用例全过」的覆盖率 job 仍以 exit 1 判红（2026-11-05 CI 实测）。
  // act() 不是靠等时机，而是强制排空 React 自己的调度队列；再留一轮宏任务给
  // mock promise 链落地，确保组件卸载后的残余提交都在 jsdom 存活期内完成。
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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

// 测试性能优化（2026-10-19）：禁用 @ant-design/cssinjs 的样式注入与哈希计算。
// 背景：antd v5 每次 renderLight 都会把整页样式以 <style> 注入 jsdom head，
// 且 useStyleRegister 要算 :where 选择器哈希——这是 jsdom 下每挂载 ~8s 的主因
// （实测占 OrdersPage 全文件 ~100s 的 92%）。jsdom 只验证 DOM 结构/交互，
// 计算样式由 ui_guards（lint 期）+ agent-browser（真机）把关，测试层不需要真实样式。
// 安全性：antd 静态 class（如 ant-alert / ant-tabs-tab）由组件直接应用，不依赖 cssinjs，
// 因此 .ant-* 类选择器断言照常生效；仅跳过 <style> 注入与哈希计算。
// 影响：全量 test:full 301.87s → 59.32s（~5.1×），OrdersPage 12 用例 ~101s → ~8s（~12×），零回归。
vi.mock("@ant-design/cssinjs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    StyleProvider: ({ children }: { children?: unknown }) => children ?? null,
    useStyleRegister: () => [(node: unknown) => node, "css-mock-hash"],
    extractStyle: () => "",
    createCache: () => ({}) as unknown,
  };
});
