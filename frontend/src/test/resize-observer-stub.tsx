import React from "react";

// rc-resize-observer 的**默认导出是 React 组件**（包裹 children 并监听尺寸变化），
// 而不是浏览器的原生 ResizeObserver class。rc-table 会这样用它：
//   <ResizeObserver onResize={...}>{children}</ResizeObserver>
// 因此这里必须导出一个渲染 children 的函数组件。若导出 class，React 会按函数组件
// 直接调用它，报 "Class constructor ResizeObserverStub cannot be invoked without 'new'"。
//
// 浏览器原生的 `ResizeObserver` 全局 polyfill 在 test-setup.ts 中提供（那一个是真 class）。
//
// ⚠️ 关键（render-prop children，2026-09-04 实测踩坑）：
// 真实 rc-resize-observer 的 children 支持**函数（render-prop）**——以 ref 为参数回调：
//   <ResizeObserver onResize={...}>{(ref) => <div ref={ref}>...</div>}</ResizeObserver>
// @rc-component/trigger（Select/DatePicker/Popover/Tooltip 等一切 antd 弹层）正是这样用的。
// 若 stub 把函数当普通 ReactNode 渲染，React 会静默输出空（只有 "Functions are not
// valid as a React child" 警告），后果是：弹层 portal 容器存在但永远为空——
// 表现为 Select 已加 ant-select-open 却查不到 .ant-select-dropdown / .ant-select-item-option，
// 且 Motion stub 完全不被命中（因为 ResizeObserver 先把 children 弄丢了）。
// 所以 stub 必须与真实组件一致：函数 → 传入 ref 回调；普通节点 → 原样渲染。

type ResizeObserverChildren =
  | React.ReactNode
  | ((ref: React.RefObject<any>) => React.ReactNode);

const ResizeObserverStub = React.forwardRef<any, { children?: ResizeObserverChildren }>(
  function ResizeObserverStub({ children }, forwardedRef): React.ReactNode {
    const ref: React.RefObject<any> =
      typeof forwardedRef === "function" ? React.createRef<any>() : (forwardedRef ?? React.createRef<any>());
    if (typeof children === "function") {
      return <>{children(ref) ?? null}</>;
    }
    return <>{children ?? null}</>;
  },
);

// rc-table 的部分路径使用 <ResizeObserver.Collection>，一并导出。
const Collection = ({ children }: { children?: React.ReactNode }): React.ReactNode => (
  <>{children ?? null}</>
);

(ResizeObserverStub as unknown as { Collection: typeof Collection }).Collection = Collection;

export default ResizeObserverStub;
export { Collection };
