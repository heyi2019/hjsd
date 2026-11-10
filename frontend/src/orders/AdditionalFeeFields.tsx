import { Form, Input } from "antd";
import { useRef } from "react";
import { AdaptiveFormGrid, BusinessRegistrationGroup, MoneyInput, PermissionButton } from "../shared/ui";
import { CfgNestedItem } from "./ConfigurableField";
import "./AdditionalFeeFields.css";
import type { Pool } from "../shared/api/catalog";
import { Select } from "../shared/ui";

/** 回收、提号共用的其他支出字段；业务自身的主金额和提交事件由上层处理。 */
export function AdditionalFeeFields(props: { pools: Pool[] }) {
  const addExpenseRef = useRef<((defaultValue?: unknown, insertIndex?: number) => void) | null>(null);

  return (
    <BusinessRegistrationGroup
      className="additional-fee-fields"
      title="其他支出"
      action={
        <PermissionButton permission="order.create" type="link" onClick={() => addExpenseRef.current?.({})}>
          + 增加支出
        </PermissionButton>
      }
    >
      {/* 中介费固定行：顶层表单字段，必须放在 Form.List 之外。
          原先误置于 Form.List 内部，antd 会强制给 name 加 expense_items. 前缀，
          导致值写入 expense_items.intermediary_fee、污染数组字段并让 Form.List 重渲染崩溃（点击即报错）。 */}
      <AdaptiveFormGrid className="fee-row">
        <CfgNestedItem name="intermediary_fee" label="中介费"><MoneyInput placeholder="金额" /></CfgNestedItem>
        <CfgNestedItem name="intermediary_pool_id" fixedLabel="资金账户"><Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} /></CfgNestedItem>
      </AdaptiveFormGrid>
      <Form.List name="expense_items">
        {(fields, { add, remove }) => {
          addExpenseRef.current = add;
          return (
            <>
              <AdaptiveFormGrid className="fee-row additional-expense-list">
                {fields.map((field) => <div className="additional-expense-row" key={field.key}>
                  <Form.Item name={[field.name, "amount"]} label="金额" rules={[{ required: true, message: "请输入支出金额" }]}><MoneyInput placeholder="金额" /></Form.Item>
                  <Form.Item name={[field.name, "pool_id"]} label="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}><Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} /></Form.Item>
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
