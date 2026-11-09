/** 订单表单小组件：客户来源与附加费用（中介费/支出行）字段路径。 */
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Button, Form, type FormInstance } from "antd";
import { renderLight } from "@fixtures/render";
import { CustomerSourceFields } from "@/orders/CustomerSourceInput";
import { AdditionalFeeFields } from "@/orders/AdditionalFeeFields";

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

/** 回归锁：中介费是顶层表单字段，不能放进 Form.List 内部；资金账户由父级主金额字段统一提供。 */
describe("AdditionalFeeFields：中介费字段路径", () => {
  let ui: ReturnType<typeof userEvent.setup>;

  function renderFeeForm() {
    let formRef: FormInstance | null = null;
    function Harness() {
      const [form] = Form.useForm();
      formRef = form;
      return (
        <Form form={form}>
          <AdditionalFeeFields />
        </Form>
      );
    }
    const utils = renderLight(<Harness />, { user: "admin" });
    return { ...utils, getForm: () => formRef as FormInstance };
  }

  beforeEach(() => {
    ui = userEvent.setup({ pointerEventsCheck: 0 });
  });

  it("中介费写入顶层字段，不污染 expense_items 数组", async () => {
    const { getForm } = renderFeeForm();
    const feeInput = screen.getByPlaceholderText("金额");
    await ui.type(feeInput, "500");

    // 顶层字段能读到（修复前此处为 undefined，因为值被塞进了 expense_items.intermediary_fee）
    expect(getForm().getFieldValue("intermediary_fee")).toBe("500");

    // 数组字段不得被混入对象属性而变成混合结构
    const expenseItems = getForm().getFieldValue("expense_items");
    expect(expenseItems == null || Array.isArray(expenseItems)).toBe(true);
    expect({}.hasOwnProperty.call(expenseItems ?? {}, "intermediary_fee")).toBe(false);
  });

  it("点击增加支出向 expense_items 追加一项且不污染中介费", async () => {
    const { getForm } = renderFeeForm();
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
