import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";
import { BusinessActionModal } from "./BusinessActionModal";
import { CompactActions } from "./CompactActions";

describe("CompactActions", () => {
  it("渲染确认子节点与右侧「取消」按钮", () => {
    renderLight(
      <CompactActions onCancel={vi.fn()}>
        <button type="submit">确认锁定</button>
      </CompactActions>,
    );

    expect(screen.getByText("确认锁定")).toBeInTheDocument();
    const cancel = screen.getByText("取消").closest("button");
    expect(cancel).toBeTruthy();
  });

  it("点击「取消」走显式 onCancel prop（优先级最高）", () => {
    const onCancel = vi.fn();
    renderLight(
      <CompactActions onCancel={onCancel}>
        <button type="submit">确认</button>
      </CompactActions>,
    );

    fireEvent.click(screen.getByText("取消").closest("button")!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("divider 默认 true（操作条带分隔线），为 false 时加 no-divider 类", () => {
    const { unmount } = renderLight(
      <CompactActions onCancel={vi.fn()}>
        <button>确认</button>
      </CompactActions>,
    );
    expect(document.querySelector(".compact-form-actions")).not.toHaveClass("no-divider");

    unmount();
    renderLight(
      <CompactActions onCancel={vi.fn()} divider={false}>
        <button>确认</button>
      </CompactActions>,
    );
    expect(document.querySelector(".compact-form-actions.no-divider")).toBeTruthy();
  });

  it("无显式 onCancel 时回落到 ModalCancelContext（弹窗内用法）", () => {
    const onCancel = vi.fn();
    renderLight(
      <BusinessActionModal open onCancel={onCancel} title="锁定账期">
        <CompactActions>
          <button type="submit">确认锁定</button>
        </CompactActions>
      </BusinessActionModal>,
      { user: "admin" },
    );

    // CompactActions 在弹窗 children 作用域内，应取到 BusinessActionModal 下发的 onCancel。
    fireEvent.click(screen.getByText("取消").closest("button")!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
