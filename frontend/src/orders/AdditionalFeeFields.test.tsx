import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Form, type FormInstance } from "antd";
import { renderLight } from "../test/render";
import { AdditionalFeeFields } from "./AdditionalFeeFields";
import type { Pool } from "../shared/api/catalog";

const pools: Pool[] = [
  { id: 1, code: "MAIN", name: "主账户", pool_type: "CASH", ownership: "OWNED", status: "ACTIVE" },
];

/** 回归锁：中介费 / 支出账户是顶层表单字段，绝不能放进 Form.List 内部，
 *  否则 antd 会强制给 name 加 expense_items. 前缀，导致值写入
 *  expense_items.intermediary_fee、污染数组并让 Form.List 重渲染崩溃（点击即报错）。 */
describe("AdditionalFeeFields：中介费字段路径", () => {
  let ui: ReturnType<typeof userEvent.setup>;

  function renderFeeForm() {
    let formRef: FormInstance | null = null;
    function Harness() {
      const [form] = Form.useForm();
      formRef = form;
      return (
        <Form form={form}>
          <AdditionalFeeFields pools={pools} />
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
});
