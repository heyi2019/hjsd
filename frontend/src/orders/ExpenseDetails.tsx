import { Form, Input } from "antd";
import { useRef } from "react";
import type { ReactNode } from "react";
import { AdaptiveFormGrid, BusinessRegistrationGroup, MoneyInput, PermissionButton } from "../shared/ui";
import "./ExpenseDetails.css";

/** 回收、提号共用的资金支出明细；与主金额和资金账户共用同一资金明细卡片。 */
export function ExpenseDetails({ children }: { children?: ReactNode }) {
  const addExpenseRef = useRef<((defaultValue?: unknown, insertIndex?: number) => void) | null>(null);

  return (
    <BusinessRegistrationGroup
      className="primary-amount-fields"
      action={
        <PermissionButton permission="order.create" type="link" onClick={() => addExpenseRef.current?.({})}>
          + 增加支出
        </PermissionButton>
      }
    >
      {children}
      <Form.List name="expense_items">
        {(fields, { add, remove }) => {
          addExpenseRef.current = add;
          return (
            <AdaptiveFormGrid className="expense-details-list">
              {fields.map((field) => <div className="expense-detail-row" key={field.key}>
                <Form.Item name={[field.name, "amount"]} label="金额" rules={[{ required: true, message: "请输入支出金额" }]}><MoneyInput placeholder="金额" /></Form.Item>
                <Form.Item name={[field.name, "note"]} label="支出备注"><Input placeholder="可选填" /></Form.Item>
                <PermissionButton permission="order.create" type="link" danger onClick={() => remove(field.name)}>删除</PermissionButton>
              </div>)}
            </AdaptiveFormGrid>
          );
        }}
      </Form.List>
    </BusinessRegistrationGroup>
  );
}
