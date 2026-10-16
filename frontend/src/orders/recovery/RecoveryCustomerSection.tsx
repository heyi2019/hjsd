import { Form, Input } from "antd";
import { NestedFormField, Select } from "../../shared/ui";
import { CUSTOMER_SOURCE_OPTIONS } from "./recoveryConfig";
import "./RecoveryCustomerSection.css";

export function RecoveryCustomerSection(props: { customerSource?: string }) {
  const isOtherSource = props.customerSource === "其他";

  return (
    <section className="recovery-customer-section recovery-customer-fields" aria-labelledby="customer-info-title">
      <div id="customer-info-title" className="recovery-customer-fields__title">客户信息</div>
      <Form.Item className="recovery-order-modal__party-field" name="customer_nickname" label="客户昵称" rules={[{ required: true, message: "请输入客户昵称" }]}><Input placeholder="请输入客户昵称" /></Form.Item>
      <Form.Item className="recovery-order-modal__party-field" name="customer_source" label="客户来源" rules={[{ required: true, message: "请选择客户来源" }]}>
        <Select placeholder="请选择客户来源" options={CUSTOMER_SOURCE_OPTIONS} />
      </Form.Item>
      <Form.Item className="recovery-order-modal__party-field recovery-customer-source-other" name="customer_source_other" label="其他来源" rules={isOtherSource ? [{ required: true, message: "请输入客户来源" }] : []}>
        <Input disabled={!isOtherSource} placeholder={isOtherSource ? "请输入来源名称" : "选择其他后可填写"} />
      </Form.Item>
      <div className="recovery-customer-contacts">
        <div className="recovery-customer-contacts__title">联系方式</div>
        <NestedFormField className="recovery-fee-field" label="姓名"><Form.Item noStyle name="customer_contact_name"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
        <NestedFormField className="recovery-fee-field" label="手机号"><Form.Item noStyle name="customer_phone"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
        <NestedFormField className="recovery-fee-field" label="微信号"><Form.Item noStyle name="customer_wechat"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
        <NestedFormField className="recovery-fee-field" label="QQ"><Form.Item noStyle name="customer_qq"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
      </div>
      <Form.Item className="recovery-order-modal__note-field" name="note" label="客户备注">
        <Input.TextArea rows={2} placeholder="可填写账号来源、特殊说明等" />
      </Form.Item>
    </section>
  );
}
