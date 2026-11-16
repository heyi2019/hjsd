/** 订单表单小组件：客户来源与支出明细字段路径。 */
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Button, Form, type FormInstance } from "antd";
import { renderLight } from "@fixtures/render";
import { seedOptionSets } from "@fixtures/formFieldsSeed";
import { CustomerSourceFields } from "@/orders/CustomerSourceInput";
import { FinanceExpenseItems } from "@/orders/finance/FinanceExpenseItems";
import { clearOptionSetsCache } from "@/shared/lib/optionSets";

vi.mock("@/shared/api/options.api");

beforeEach(() => {
  clearOptionSetsCache();
  seedOptionSets();
});

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

  /** L258 回归：客户来源选「其他」但留空时，校验提示应为「请输入其他来源」，
   *  而非笼统的「请输入客户来源」（两者语义不同，旧文案误导填写人）。 */
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
});

describe("FinanceExpenseItems：支出明细字段", () => {
  let ui: ReturnType<typeof userEvent.setup>;

  function renderFeeForm() {
    let formRef: FormInstance | null = null;
    function Harness() {
      const [form] = Form.useForm();
      formRef = form;
      return (
        <Form form={form}>
        <FinanceExpenseItems />
        </Form>
      );
    }
    const utils = renderLight(<Harness />, { user: "admin" });
    return { ...utils, getForm: () => formRef as FormInstance };
  }

  beforeEach(() => {
    ui = userEvent.setup({ pointerEventsCheck: 0 });
  });

  it("点击增加支出只追加金额和备注字段", async () => {
    const { getForm } = renderFeeForm();
    await ui.click(screen.getByText("+ 增加支出"));
    const list = getForm().getFieldValue("expense_items");
    expect(Array.isArray(list) && list.length === 1).toBe(true);
    expect(screen.getByPlaceholderText("金额")).toBeInTheDocument();
    expect(screen.getByText("支出备注")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("可选填")).toBeInTheDocument();
    expect(screen.queryByText("中介费")).toBeNull();
    expect(screen.queryByText("资金账户")).toBeNull();
    expect(screen.queryByText("支出名称")).not.toBeInTheDocument();
  });
});
