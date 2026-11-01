/** L258 回归：客户来源选「其他」但留空时，校验提示应为「请输入其他来源」，
 *  而非笼统的「请输入客户来源」（两者语义不同，旧文案误导填写人）。 */
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Button, Form } from "antd";
import { CustomerSourceFields } from "./CustomerSourceInput";
import { renderLight } from "../test/render";

function Harness() {
  const [form] = Form.useForm();
  const [submitted, setSubmitted] = useState(false);
  return (
    <Form form={form} onFinish={() => setSubmitted(true)}>
      <CustomerSourceFields name="customer_source" otherName="customer_source_other" />
      <Button htmlType="submit" type="primary">提交</Button>
      {submitted ? <span data-testid="submitted">已提交</span> : null}
    </Form>
  );
}

it("L258：客户来源选「其他」且未填具体来源时，提示「请输入其他来源」", async () => {
  const user = userEvent.setup();
  renderLight(<Harness />, { user: "admin" });

  // 打开客户来源下拉并选择「其他」
  await user.click(screen.getByText("客户来源").closest(".ant-form-item")!.querySelector(".ant-select-selector")!);
  const option = await screen.findByText("其他", { selector: ".ant-select-item-option-content" });
  await user.click(option);

  // 提交触发校验：other 字段为空，应报「请输入其他来源」
  await user.click(screen.getByRole("button", { name: /提交/ }));

  await waitFor(() =>
    expect(screen.getByText("请输入其他来源")).toBeInTheDocument(),
  );
  // 旧文案不应出现
  expect(screen.queryByText("请输入客户来源")).toBeNull();
  // 校验未过，不应提交成功
  expect(screen.queryByTestId("submitted")).toBeNull();
});
