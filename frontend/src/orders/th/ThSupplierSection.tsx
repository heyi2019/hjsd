import { Form, Input } from "antd";
import { NestedFormField, Select } from "../../shared/ui";

const SUPPLIER_SOURCE_OPTIONS = ["氪金联盟", "同行", "其他"]
  .map((value) => ({ value, label: value }));

/** 提号复用回收页客户信息的结构，只将业务主体替换为供货方。 */
export function ThSupplierSection() {
  const supplierSource = Form.useWatch("supplier_source");
  return (
    <section className="th-supplier-section recovery-customer-fields" aria-labelledby="supplier-info-title">
      <div id="supplier-info-title" className="recovery-customer-fields__title">供货方信息</div>
      <Form.Item className="recovery-order-modal__party-field" name="supplier_nickname" label="供货方昵称" rules={[{ required: true, message: "请输入供货方昵称" }]}>
        <Input placeholder="请输入供货方昵称" />
      </Form.Item>
      <Form.Item className="recovery-order-modal__party-field" name="supplier_source" label="供货方来源" rules={[{ required: true, message: "请选择供货方来源" }]}>
        <Select placeholder="请选择供货方来源" options={SUPPLIER_SOURCE_OPTIONS} />
      </Form.Item>
      <Form.Item className="recovery-order-modal__party-field recovery-customer-source-other" name="supplier_source_other" label="其他来源" rules={supplierSource === "其他" ? [{ required: true, whitespace: true, message: "请输入供货方来源" }] : []}>
        <Input disabled={supplierSource !== "其他"} placeholder={supplierSource === "其他" ? "请输入来源名称" : "选择其他后可填写"} />
      </Form.Item>
      <div className="recovery-customer-contacts">
        <div className="recovery-customer-contacts__title">联系方式</div>
        <NestedFormField className="recovery-fee-field" label="公司名"><Form.Item noStyle name="supplier_contact_name"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
        <NestedFormField className="recovery-fee-field" label="手机号"><Form.Item noStyle name="supplier_phone"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
        <NestedFormField className="recovery-fee-field" label="微信号"><Form.Item noStyle name="supplier_wechat"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
        <NestedFormField className="recovery-fee-field" label="QQ"><Form.Item noStyle name="supplier_qq"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
      </div>
      <Form.Item className="recovery-order-modal__note-field" name="supplier_note" label="供货方备注">
        <Input.TextArea rows={2} placeholder="可填写供货来源、特殊说明等" />
      </Form.Item>
    </section>
  );
}
