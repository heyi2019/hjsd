import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { BusinessActionModal } from "@/shared/ui/BusinessActionModal";
import { Select } from "@/shared/ui/Select";

// 本文件局部覆盖 rc-motion：尊重传入的 visible（open=false 时弹层真正卸载），
// 使 antd Select 下拉「打开/关闭」在 jsdom 中可被观测（否则落到全局 motion-stub 的
// 强制 visible:true，弹层永远残留，无法判定「下拉是否已关」）。
// 打开的 Modal/下拉仍按 open=true 渲染内容，不影响其余用例。
vi.mock("rc-motion", async () => {
  const React = await import("react");
  const CSSMotion = React.forwardRef<unknown, any>(function CSSMotion(
    { children, visible, ...rest },
    ref,
  ) {
    const isVisible = visible !== undefined ? Boolean(visible) : true;
    if (!isVisible) return null;
    const content =
      typeof children === "function"
        ? children({ ...rest, visible: true }, ref)
        : children;
    if (React.isValidElement(content) && ref) {
      return React.cloneElement(content as React.ReactElement<any>, { ref });
    }
    return (content ?? null) as React.ReactNode;
  });
  const CSSMotionList = React.forwardRef<unknown, any>(function CSSMotionList(props, _ref) {
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
    return <div className={className} style={style}>{items}</div>;
  });
  const Provider = ({ children }: { children?: React.ReactNode }) => children ?? null;
  return { CSSMotion, CSSMotionList, Provider, default: CSSMotion };
});

describe("BusinessActionModal", () => {
  it("复用建单弹窗的完整可拖拽缩放外壳", () => {
    renderLight(
      <BusinessActionModal open title="资金收支" onCancel={() => undefined}>
        <div>内容</div>
      </BusinessActionModal>,
      { user: "admin" },
    );

    expect(document.querySelector(".adaptive-business-modal.business-registration-modal")).toBeTruthy();
    expect(document.querySelector(".resizable-modal__drag-handle")).toHaveTextContent("资金收支");
    expect(screen.getByText("内容")).toBeInTheDocument();
  });

  it("P2-194：打开弹窗时重置 .ant-modal-body 滚动位置（避免承接上一弹窗旧滚动）", async () => {
    const { rerender } = renderLight(
      <BusinessActionModal open title="测试" onCancel={() => undefined}>
        <div style={{ height: 2000 }}>长内容</div>
      </BusinessActionModal>,
      { user: "admin" },
    );
    const body = () => document.querySelector<HTMLElement>(".ant-modal-body");
    // 弹窗已挂载：模拟上一弹窗滚动过，body 残留非零 scrollTop
    expect(body()).not.toBeNull();
    body()!.scrollTop = 150;
    expect(body()!.scrollTop).toBe(150);
    // 关闭再打开（destroyOnClose=false，body DOM 被复用）：open 由 false 切 true 触发
    // 重置副作用，把复用 body 的 scrollTop 归零（P2-194）。
    rerender(
      <BusinessActionModal open={false} title="测试" onCancel={() => undefined}>
        <div style={{ height: 2000 }}>长内容</div>
      </BusinessActionModal>,
    );
    rerender(
      <BusinessActionModal open title="测试" onCancel={() => undefined}>
        <div style={{ height: 2000 }}>长内容</div>
      </BusinessActionModal>,
    );
    await waitFor(() => expect(body()!.scrollTop).toBe(0));
  });

  it("P2-262：内嵌下拉打开时按 Esc 先关下拉、不触发 onCancel（不误弹放弃确认）", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderLight(
      <BusinessActionModal open title="测试" onCancel={onCancel}>
        <Select
          options={[
            { value: "a", label: "选项A" },
            { value: "b", label: "选项B" },
          ]}
          placeholder="请选择"
        />
      </BusinessActionModal>,
      { user: "admin" },
    );

    // 打开下拉
    await user.click(screen.getByText("请选择").closest(".ant-select-selector")!);
    expect(await screen.findByText("选项A")).toBeInTheDocument();
    expect(document.querySelector(".ant-select-open")).not.toBeNull();

    // 下拉打开态按 Esc：应关闭下拉，但不触发弹窗 onCancel
    const selectInput = document.querySelector<HTMLElement>(".ant-select-selection-search-input")!;
    fireEvent.keyDown(selectInput, { key: "Escape", keyCode: 27, which: 27 });
    await waitFor(() => expect(document.querySelector(".ant-select-open")).toBeNull());
    expect(onCancel).not.toHaveBeenCalled();

    // 下拉已关、无浮层时再按 Esc：应触发弹窗 onCancel
    const selectInputAfter = document.querySelector<HTMLElement>(".ant-select-selection-search-input")!;
    fireEvent.keyDown(selectInputAfter, { key: "Escape", keyCode: 27, which: 27 });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
