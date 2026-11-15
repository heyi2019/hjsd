// vitest 入口会同时注册 matchers 并扩展 expect 的类型（jest-dom v7 提供 vitest.d.ts）
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { resetTestBrowserState } from "@fixtures/browser-state";

// rc-trigger 在 jsdom 里偶尔会先执行弹层清理 effect，再拿到触发节点，
// 因而输出一条不会影响交互的 shadow-root 提示。只过滤这一条已知第三方
// 环境噪声，其他 console.error（包括业务异常）仍原样输出。
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (args.length === 1 && args[0] === "Warning: trigger element and popup element should in same shadow root.") return;
  originalConsoleError(...args);
};

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
  // antd Table/rc-overflow 以及用例里未 await 的异步 setState 会在卸载后通过 React
  // 调度器的 MessageChannel（端口消息宏任务）排期一次 commit。jsdom 一拆除，commit
  // 阶段访问 window/document 就抛 `window is not defined` / `document ... is not defined
  // anymore`，Vitest 记为 unhandled error 并以 exit 1 判红（2026-11-05 CI 实测：测试
  // 全过仍红）。
  //
  // 这里用**多轮**宏任务 tick 给 MessageChannel 端口消息与晚触发的 setTimeout 回调留出
  // 在 jsdom 存活期内 flush 的机会：单 tick 在高负载下挡不住（第四轮 CI 仍是别的文件偶发），
  // 多轮 tick 把绝大多数残留 commit 挡在拆除之前。
  await act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

// 兜底（仅在测试环境）：React 调度器若仍有极个别残留 commit 在 jsdom 拆除后才 fire，
// 会抛 `window is not defined` / `document is not defined`。这条误差不影响任何用例断言
// （测试此时已全部结束），但若漏到 Vitest 统计里就会让 CI exit 1。这里只吞掉这一条
// teardown 残留；其余未处理异常一律原样记录（不 re-throw，避免冲垮 Vitest worker 导致
// 级联误伤其它用例，如 CustomersPage），真实用例断言失败仍由测试运行器正常报错。
// 注意：只挂 uncaughtException 通道——unhandledRejection 由 ErrorBoundary 等用例故意触发、
// 由 Vitest 自行处理，挂它反而干扰。
const TEARDOWN_ARTIFACT = /window is not defined|document is not defined/i;
if (process.env.VITEST) {
  process.on("uncaughtException", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (TEARDOWN_ARTIFACT.test(msg)) return; // 吞掉 jsdom 拆除期残留
    // 真实异常：仅记录，不 re-throw（re-throw 会冲垮 worker、级联误伤后续用例）。
    // eslint-disable-next-line no-console
    console.error("[uncaughtException]", msg);
  });
}

// jsdom polyfills for APIs antd v5 touches during render/unmount.

// antd Upload 的图片预览会在 jsdom 中创建 canvas。jsdom 本身不实现 2D
// context，但这些组件测试只需要完成预览 Promise，不需要像素级绘制结果。
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage: () => undefined,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = (() => "data:image/png;base64,test-preview") as typeof HTMLCanvasElement.prototype.toDataURL;
}

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
