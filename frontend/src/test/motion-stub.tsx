import React from "react";

// Zero-motion stand-in for `rc-motion`, aliased in vitest.config.ts.
// The CRITICAL contract: CSSMotionList MUST faithfully iterate `keys` and call
// the render-prop `(item, nodeRef) => ReactNode` with `{ key, config, index }`.
// A naive stub that treats CSSMotionList like CSSMotion (ignoring `keys`) yields
// empty output and silent render failures. rc-notification's NoticeList uses
// CSSMotionList, so stubbing rc-motion here prevents "destroy is not a function"
// noise from that library.

export const CSSMotion = React.forwardRef<unknown, any>(function CSSMotion(
  { children, ...rest },
  ref,
) {
  const content =
    typeof children === "function"
      ? children({ ...rest, visible: true }, ref)
      : children;
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
