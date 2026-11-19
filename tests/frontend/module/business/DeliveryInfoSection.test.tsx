/** L254 回归：交易平台选「其他」时出现「其他平台」自定义输入框（与客户来源联动一致），
 *  且留空校验提示「请输入交易平台名称」；切换到非「其他」时自定义输入消失。 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { Button, Form } from "antd";
import { DeliveryInfoSection } from "@/business/DeliveryInfoSection";
import { renderLight } from "@fixtures/render";

vi.mock("@/shared/lib/optionSets", () => ({
  useOptionSet: (code: string) =>
    code === "INTERMEDIARY_PLATFORM"
      ? [
          { value: "淘宝", label: "淘宝" },
          { value: "其他", label: "其他" },
        ]
      : [],
}));

function Harness() {
  const [form] = Form.useForm();
  const [submitted, setSubmitted] = useState(false);
  return (
    <Form form={form} onFinish={() => setSubmitted(true)}>
      <DeliveryInfoSection showIntermediary />
      <Button htmlType="submit" type="primary">提交</Button>
      {submitted ? <span data-testid="submitted">已提交</span> : null}
    </Form>
  );
}

describe("DeliveryInfoSection：交易平台「其他」自定义输入（L254）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("选「其他」后显示「其他平台」输入框", async () => {
    const user = userEvent.setup();
    renderLight(<Harness />, { user: "admin" });

    // 初始不应有「其他平台」输入框
    expect(screen.queryByLabelText("其他平台")).toBeNull();

    await user.click(screen.getByText("交易平台").closest(".ant-form-item")!.querySelector(".ant-select-selector")!);
    await user.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));

    await waitFor(() => expect(screen.getByLabelText("其他平台")).toBeInTheDocument());
  });

  it("选「其他」且留空时校验提示「请输入交易平台名称」", async () => {
    const user = userEvent.setup();
    renderLight(<Harness />, { user: "admin" });

    await user.click(screen.getByText("交易平台").closest(".ant-form-item")!.querySelector(".ant-select-selector")!);
    await user.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(screen.getByLabelText("其他平台")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /提交/ }));
    await waitFor(() => expect(screen.getByText("请输入交易平台名称")).toBeInTheDocument());
    expect(screen.queryByTestId("submitted")).toBeNull();
  });

  it("切换为非「其他」时「其他平台」输入框消失", async () => {
    const user = userEvent.setup();
    renderLight(<Harness />, { user: "admin" });

    await user.click(screen.getByText("交易平台").closest(".ant-form-item")!.querySelector(".ant-select-selector")!);
    await user.click(await screen.findByText("其他", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(screen.getByLabelText("其他平台")).toBeInTheDocument());

    // 重新打开并改选「淘宝」
    await user.click(screen.getByText("交易平台").closest(".ant-form-item")!.querySelector(".ant-select-selector")!);
    await user.click(await screen.findByText("淘宝", { selector: ".ant-select-item-option-content" }));
    await waitFor(() => expect(screen.queryByLabelText("其他平台")).toBeNull());
  });
});
