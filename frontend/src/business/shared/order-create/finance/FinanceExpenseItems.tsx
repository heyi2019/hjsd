import { Form, Input } from "antd";
import { requiredMoneyRules } from "../../../../shared/lib/validators";
import { AdaptiveFormGrid, MoneyInput, PermissionButton } from "../../../../shared/ui";
import "./FinanceExpenseItems.css";

/**
 * 资金明细中的可选支出行。
 *
 * 主资金账户由业务费用卡片负责；这里仅维护 expense_items：金额和备注。
 * 这里不负责业务类型判断，避免费用字段散落在多个表单区块。
 */
export function FinanceExpenseItems({ className }: { className?: string }) {
  return (
    <div className={["finance-expense-items", className].filter(Boolean).join(" ")}>
      <Form.List name="expense_items">
        {(fields, { add, remove }) => (
          <AdaptiveFormGrid className="finance-expense-items__list">
            <div className="finance-expense-items__action">
              <PermissionButton permission="order.create" type="link" onClick={() => add({})}>
                + 增加支出
              </PermissionButton>
            </div>
            {fields.map((field) => (
              <div className="finance-expense-items__row" key={field.key}>
                <Form.Item
                  name={[field.name, "amount"]}
                  label="金额"
                  rules={[
                    ...requiredMoneyRules("支出金额"),
                    { validator: (_rule, value) => value !== undefined && value !== null && value !== "" && Number(value) === 0
                      ? Promise.reject(new Error("支出金额必须大于 0")) : Promise.resolve() },
                  ]}
                >
                  <MoneyInput placeholder="金额" />
                </Form.Item>
                <Form.Item name={[field.name, "note"]} label="支出备注">
                  <Input placeholder="可选填" />
                </Form.Item>
                <PermissionButton permission="order.create" type="link" danger onClick={() => remove(field.name)}>
                  删除
                </PermissionButton>
              </div>
            ))}
          </AdaptiveFormGrid>
        )}
      </Form.List>
    </div>
  );
}
