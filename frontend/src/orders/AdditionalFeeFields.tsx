import { Form, Input } from "antd";
import { AdaptiveFormGrid, MoneyInput, NestedFormSection, PermissionButton } from "../shared/ui";
import { CfgNestedItem } from "./ConfigurableField";
import "./AdditionalFeeFields.css";
import type { Pool } from "../shared/api/catalog";
import { Select } from "../shared/ui";

/** 回收、提号共用的附加费用字段；业务自身的主金额和提交事件由上层处理。 */
export function AdditionalFeeFields(props: { pools: Pool[] }) {
  return (
    <Form.List name="expense_items">
      {(fields, { add, remove }) => (
        <NestedFormSection
          className="nested-form-section--card recovery-fee-card"
          headerClassName="recovery-fee-card__head"
          titleClassName="recovery-fee-card__label"
          descriptionClassName="recovery-fee-card__desc"
          title="附加费用"
          description={<PermissionButton permission="order.create" type="link" onClick={() => add({})}>+ 增加支出</PermissionButton>}
        >
          <AdaptiveFormGrid className="recovery-fee-row">
            <CfgNestedItem className="recovery-fee-field" name="intermediary_fee" label="中介费"><MoneyInput className="recovery-fee-control" placeholder="金额" /></CfgNestedItem>
            <CfgNestedItem className="recovery-fee-field" name="intermediary_pool_id" label="支出账户"><Select className="recovery-fee-control" placeholder="请选择账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} /></CfgNestedItem>
          </AdaptiveFormGrid>
          <AdaptiveFormGrid className="recovery-fee-row additional-expense-list">
            {fields.map((field) => <div className="additional-expense-row" key={field.key}>
              <Form.Item name={[field.name, "name"]} label="支出名称" rules={[{ required: true, message: "请输入支出名称" }]}><Input placeholder="例如：打赏" /></Form.Item>
              <Form.Item name={[field.name, "amount"]} label="金额" rules={[{ required: true, message: "请输入支出金额" }]}><MoneyInput placeholder="金额" /></Form.Item>
              <Form.Item name={[field.name, "pool_id"]} label="支出账户" rules={[{ required: true, message: "请选择支出账户" }]}><Select placeholder="请选择账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} /></Form.Item>
              <Form.Item name={[field.name, "note"]} label="支出备注"><Input placeholder="可选填" /></Form.Item>
              <PermissionButton permission="order.create" type="link" danger onClick={() => remove(field.name)}>删除</PermissionButton>
            </div>)}
          </AdaptiveFormGrid>
        </NestedFormSection>
      )}
    </Form.List>
  );
}
