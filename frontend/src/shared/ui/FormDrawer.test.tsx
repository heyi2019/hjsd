import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../../test/render";
import { FormDrawer } from "./FormDrawer";

const fields = [
  { name: "amount", label: "金额", required: true, kind: "money" as const },
  { name: "note", label: "备注", kind: "textarea" as const, initialValue: "初始备注" },
];

describe("FormDrawer：金额动作必须走抽屉提交", () => {
  it("关闭态不渲染内容", () => {
    const { container } = renderApp(
      <FormDrawer open={false} title="收款" fields={fields} onClose={() => {}} onSubmit={() => {}} />,
    );
    expect(container.querySelector(".ant-drawer-content")).toBeNull();
  });

  it("打开后渲染字段与初始值", async () => {
    renderApp(<FormDrawer open title="收款" fields={fields} onClose={() => {}} onSubmit={() => {}} />);
    expect(await screen.findByText("收款")).toBeInTheDocument();
    expect(screen.getByLabelText("金额")).toBeInTheDocument();
    const note = screen.getByLabelText("备注") as HTMLTextAreaElement;
    expect(note.value).toBe("初始备注");
  });

  it("必填未填时校验拦截，不触发提交", async () => {
    const onSubmit = vi.fn();
    renderApp(<FormDrawer open title="收款" fields={fields} onClose={() => {}} onSubmit={onSubmit} />);
    await userEvent.click(await screen.findByRole("button", { name: /提交/ }));
    await waitFor(() => expect(screen.getByText("请输入金额")).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("填写后提交，金额以字符串回传（不做 Number 转换）", async () => {
    const onSubmit = vi.fn();
    renderApp(<FormDrawer open title="收款" fields={fields} onClose={() => {}} onSubmit={onSubmit} />);
    await screen.findByText("收款");
    await userEvent.type(screen.getByLabelText("金额"), "1234.56");
    await userEvent.click(screen.getByRole("button", { name: /提交/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: "1234.56", note: "初始备注" });
    expect(typeof (onSubmit.mock.calls[0][0] as Record<string, unknown>).amount).toBe("string");
  });

  it("取消按钮触发 onClose", async () => {
    const onClose = vi.fn();
    renderApp(<FormDrawer open title="收款" fields={fields} onClose={onClose} onSubmit={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /取消/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("submitting 时提交按钮进入 loading，文案可自定义", async () => {
    renderApp(
      <FormDrawer
        open
        title="收款"
        fields={fields}
        submitting
        submitText="确认过账"
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    const btn = await screen.findByRole("button", { name: /确认过账/ });
    expect(btn.classList.contains("ant-btn-loading")).toBe(true);
  });

  it("extra 区域渲染在表单下方（用于校验提示等）", async () => {
    renderApp(
      <FormDrawer
        open
        title="收款"
        fields={fields}
        extra={<span>余额不足</span>}
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(await screen.findByText("余额不足")).toBeInTheDocument();
  });
});
