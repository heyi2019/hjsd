import { screen, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";
import { ConfirmDialog } from "./ConfirmDialog";
import { appMessage } from "./appFeedback";

describe("ConfirmDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    document.body.querySelectorAll('[class*="ant-modal"]').forEach((el) => el.remove());
  });

  it("open 时渲染标题、描述与默认按钮文案", () => {
    renderLight(
      <ConfirmDialog open title="删除确认" description="此操作不可撤销" okText="删除" onConfirm={vi.fn()} onCancel={vi.fn()} />,
      { user: "admin" },
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("删除确认")).toBeInTheDocument();
    expect(within(dialog).getByText("此操作不可撤销")).toBeInTheDocument();
    // 精确断言可访问名：若 rc-motion 测试桩再次忽略 visible，antd Button 会渲染 loading 图标
    // 把 name 污染成「loading 删除」，这两条会立即失败（回归护栏）。
    expect(within(dialog).getByRole("button", { name: "删除" })).toBeInTheDocument();
    // 默认取消文案
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  it("点击确认调用 onConfirm", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const ui = userEvent.setup();
    renderLight(
      <ConfirmDialog open title="删除确认" okText="删除" onConfirm={onConfirm} onCancel={vi.fn()} />,
      { user: "admin" },
    );
    await ui.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("onConfirm 失败时走全局 toast 且保持打开（由父级决定是否关闭）", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("网络异常"));
    const errorSpy = vi.spyOn(appMessage, "error");
    const ui = userEvent.setup();
    renderLight(
      <ConfirmDialog open title="删除确认" okText="删除" onConfirm={onConfirm} onCancel={vi.fn()} />,
      { user: "admin" },
    );
    await ui.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除" }));
    // normalizeError 对非 axios 错误取 String(error)（见 src/shared/api/client.ts），故上屏文案为
    // 「Error: 网络异常」；此处只校验全局 toast 触发且携带原错误文本，不过度绑定格式细节。
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("网络异常")));
    // 失败后仍打开，供用户重试
    expect(screen.getByText("删除确认")).toBeInTheDocument();
  });

  it("点击取消调用 onCancel", async () => {
    const onCancel = vi.fn();
    const ui = userEvent.setup();
    renderLight(
      <ConfirmDialog open title="删除确认" okText="删除" onConfirm={vi.fn()} onCancel={onCancel} />,
      { user: "admin" },
    );
    await ui.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
