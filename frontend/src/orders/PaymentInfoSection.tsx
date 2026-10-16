/** 通用付款信息区：回收、提号等需要付款资金记录的业务共用。 */
import { Form, Input } from "antd";
import type { Pool } from "../shared/api/catalog";
import { Select } from "../shared/ui";
import "./PaymentInfoSection.css";

export function PaymentInfoSection(props: {
  pools: Pool[];
  recipientDefault?: string;
  recipientPlaceholder?: string;
}) {
  const recipient = props.recipientDefault ?? "卖家";
  return (
    <div className="payment-info-section payment-info-fields">
      <Form.Item name="payment_pool_id" label="付款资金账户" rules={[{ required: true, message: "请选择付款资金账户" }]}>
        <Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} />
      </Form.Item>
      <Form.Item name="payment_recipient" label="付款对象" initialValue={recipient}>
        <Input placeholder={props.recipientPlaceholder ?? recipient} />
      </Form.Item>
      <Form.Item className="payment-info-fields__note" name="payment_note" label="资金流水备注">
        <Input placeholder="可选填" />
      </Form.Item>
    </div>
  );
}
