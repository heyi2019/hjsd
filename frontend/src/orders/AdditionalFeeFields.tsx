import { Form, Input } from "antd";
import { useRef } from "react";
import { AdaptiveFormGrid, BusinessRegistrationGroup, MoneyInput, PermissionButton } from "../shared/ui";
import { CfgNestedItem } from "./ConfigurableField";
import "./AdditionalFeeFields.css";

/** 回收、提号共用的附加费用字段；业务自身的主金额和提交事件由上层处理。 */
export function AdditionalFeeFields() {
  const addExpenseRef = useRef<((defaultValue?: unknown, insertIndex?: number) => void) | null>(null);

  return (
    <BusinessRegistrationGroup
      className="additional-fee-fields"
      title="附加费用"
      action={
        <PermissionButton permission="order.create" type="link" onClick={() => addExpenseRef.current?.({})}>
          + 增加支出
        </PermissionButton>
      }
    >
      {/* 中介费固定行：顶层表单字段，必须放在 Form.List 之外。 */}
      <AdaptiveFormGrid className="fee-row">
        <CfgNestedItem name="intermediary_fee" label="中介费"><MoneyInput placeholder="金额" /></CfgNestedItem>
      </AdaptiveFormGrid>
      <Form.List name="expense_items">
        {(fields, { add, remove }) => {
          addExpenseRef.current = add;
          return (
            <>
              <AdaptiveFormGrid className="fee-row additional-expense-list">
                {fields.map((field) => <div className="additional-expense-row" key={field.key}>
                  <Form.Item name={[field.name, "amount"]} label="金额" rules={[{ required: true, message: "请输入支出金额" }]}><MoneyInput placeholder="金额" /></Form.Item>
                  <Form.Item name={[field.name, "note"]} label="支出备注"><Input placeholder="可选填" /></Form.Item>
                  <PermissionButton permission="order.create" type="link" danger onClick={() => remove(field.name)}>删除</PermissionButton>
                </div>)}
              </AdaptiveFormGrid>
            </>
          );
        }}
      </Form.List>
    </BusinessRegistrationGroup>
  );
}
