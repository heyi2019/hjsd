/** 订单表单小组件：客户来源与资金支出明细字段路径。 */
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Button, Form, type FormInstance } from "antd";
import { renderLight } from "@fixtures/render";
import { CustomerSourceFields } from "@/orders/CustomerSourceInput";
import { ExpenseDetails } from "@/orders/ExpenseDetails";

describe("CustomerSourceFields：客户来源校验文案", () => {
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

  it("客户来源选「其他」且未填具体来源时，提示「请输入其他来源」", async () => {
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
    expect(screen.queryByText("请输入客户来源")).toBeNull();
    // 校验未过，不应提交成功
    expect(screen.queryByTestId("submitted")).toBeNull();
  });
});

/** 回归锁：资金支出明细与主金额位于同一个蓝色资金明细组，且不再暴露附加费用概念。 */
describe("ExpenseDetails：资金支出明细位置", () => {
  let ui: ReturnType<typeof userEvent.setup>;

  function renderFeeForm() {
    let formRef: FormInstance | null = null;
    function Harness() {
      const [form] = Form.useForm();
      formRef = form;
      return (
        <Form form={form}>
          <ExpenseDetails>
            <div data-testid="primary-finance-field">主金额</div>
          </ExpenseDetails>
        </Form>
      );
    }
    const utils = renderLight(<Harness />, { user: "admin" });
    return { ...utils, getForm: () => formRef as FormInstance };
  }

  beforeEach(() => {
    ui = userEvent.setup({ pointerEventsCheck: 0 });
  });

  it("不再渲染附加费用或中介费输入", () => {
    const { getForm } = renderFeeForm();
    expect(screen.queryByText("附加费用")).not.toBeInTheDocument();
    expect(screen.queryByText("中介费")).not.toBeInTheDocument();
    expect(screen.getByTestId("primary-finance-field")).toBeInTheDocument();
    expect(getForm().getFieldValue("intermediary_fee")).toBeUndefined();
  });

  it("点击增加支出向 expense_items 追加一项且按钮位于蓝色资金明细组", async () => {
    const { getForm } = renderFeeForm();
    const group = screen.getByTestId("primary-finance-field").closest(".business-registration-group");
    expect(group).toHaveClass("primary-amount-fields");
    expect(group).toContainElement(screen.getByText("+ 增加支出"));
    await ui.click(screen.getByText("+ 增加支出"));
    const list = getForm().getFieldValue("expense_items");
    expect(Array.isArray(list) && list.length === 1).toBe(true);
    expect(getForm().getFieldValue("intermediary_fee")).toBeUndefined();
  });

  it("新增支出行只保留金额和支出备注，不重复资金账户", async () => {
    renderFeeForm();
    await ui.click(screen.getByText("+ 增加支出"));

    expect(screen.queryByText("支出名称")).not.toBeInTheDocument();
    expect(screen.getByText("支出备注")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("可选填")).toBeInTheDocument();
    const accountLabels = Array.from(
      document.querySelectorAll(".form-field__label, .ant-form-item-label > label"),
    ).map((el) => el.textContent ?? "");
    expect(accountLabels.filter((text) => text.includes("资金账户")).length).toBe(0);
    expect(document.getElementById("intermediary_pool_id")).toBeNull();
  });
});
