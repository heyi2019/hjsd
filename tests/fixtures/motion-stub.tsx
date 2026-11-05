import React from "react";

// Zero-motion stand-in for `rc-motion`, aliased in vitest.config.ts.
// The CRITICAL contract: CSSMotionList MUST faithfully iterate `keys` and call
// the render-prop `(item, nodeRef) => ReactNode` with `{ key, config, index }`.
// A naive stub that treats CSSMotionList like CSSMotion (ignoring `keys`) yields
// empty output and silent render failures. rc-notification's NoticeList uses
// CSSMotionList, so stubbing rc-motion here prevents "destroy is not a function"
// noise from that library.
//
// Second contract: CSSMotion MUST honour `visible === false` + `removeOnLeave`
// by rendering nothing (see the inline note below). Ignoring it makes antd's
// DefaultLoadingIcon render on every icon-less Button and pollute accessible
// names, so exact `getByRole("button", { name })` queries stop matching.

export const CSSMotion = React.forwardRef<unknown, any>(function CSSMotion(
  { children, visible = true, removeOnLeave = false, ...rest },
  ref,
) {
  // `visible === false` + `removeOnLeave` 是 rc-motion 的「卸载」语义：真实实现此时不渲染
  // children。桩若忽略它（历史实现硬编码 visible: true），会让 antd Button 的
  // DefaultLoadingIcon 在「非 loading」时也渲染 loading 图标（aria-label="loading"），
  // 把按钮可访问名污染成「loading 删除」，使 getByRole("button", { name }) 精确匹配失效。
  // 仅对 removeOnLeave 的场景短路，其余（Alert/Badge 等）保持「始终渲染 + 无动效」，
  // 与真实 rc-motion 在 removeOnLeave=false 时保留节点的行为一致。
  if (visible === false && removeOnLeave) {
    return null;
  }
  const content =
    typeof children === "function" ? children({ ...rest, visible }, ref) : children;
  if (React.isValidElement(content) && ref) {
    return React.cloneElement(content as React.ReactElement<any>, { ref });
  }
  return (content ?? null) as React.ReactNode;
});

export const CSSMotionList = React.forwardRef<unknown, any>(
  function CSSMotionList(props, _ref) {
    const { keys = [], children, className, style } = props;
    const parsed = (Array.isArray(keys) ? keys : []).map((k: any) =>
      k && typeof k === "object" ? k : { key: k },
    );
    const items = parsed.map((item: any, index: number) => {
      const nodeRef = React.createRef<unknown>();
      const rendered =
        typeof children === "function"
          ? children({ ...item, index }, nodeRef)
          : children;
      return (
        <React.Fragment key={item?.key ?? index}>
          {rendered ?? null}
        </React.Fragment>
      );
    });
    return (
      <div className={className} style={style}>
        {items}
      </div>
    );
  },
);

export const Provider = ({ children }: { children?: React.ReactNode }) =>
  children ?? null;

export default CSSMotion;
