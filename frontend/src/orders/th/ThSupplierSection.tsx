import { Form, Input } from "antd";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { Select } from "../../shared/ui";
import { useOptionSet } from "../../shared/lib/optionSets";
import { SUPPLIER_SOURCE_FALLBACK_OPTIONS } from "../CustomerSourceInput";
import { CfgItem, CfgNestedItem, sectionLabel } from "../ConfigurableField";

/** 提号复用回收页客户信息的结构，只将业务主体替换为供货方。 */
export function ThSupplierSection(props: { participantExtras?: ReactNode } = {}) {
  const participantTitle = sectionLabel("PARTICIPANT", "供货方信息");
  const form = Form.useFormInstance();
  const supplierSource = Form.useWatch("supplier_source");
  const configuredOptions = useOptionSet("SUPPLIER_SOURCE");
  const sourceOptions = configuredOptions?.length ? configuredOptions : SUPPLIER_SOURCE_FALLBACK_OPTIONS;
  useEffect(() => {
    const current = form.getFieldValue("supplier_source");
    if (!sourceOptions.some((option) => option.value === current)) {
      form.setFieldValue("supplier_source", sourceOptions[0]?.value);
    }
  }, [form, sourceOptions]);
  return (
    <section className="th-supplier-section recovery-customer-fields" aria-labelledby="supplier-info-title">
      <div id="supplier-info-title" className="recovery-customer-fields__title">{participantTitle}</div>
      <CfgItem className="recovery-order-modal__party-field" name="supplier_nickname" label="供货方昵称" rules={[{ required: true, message: "请输入供货方昵称" }]}>
        <Input placeholder="请输入供货方昵称" />
      </CfgItem>
      <CfgItem className="recovery-order-modal__party-field" name="supplier_source" label="供货方来源" rules={[{ required: true, message: "请选择供货方来源" }]}>
        <Select placeholder="请选择供货方来源" options={sourceOptions} />
      </CfgItem>
      <CfgItem className="recovery-order-modal__party-field recovery-customer-source-other" name="supplier_source_other" label="其他来源" rules={supplierSource === "其他" ? [{ required: true, whitespace: true, message: "请输入供货方来源" }] : []}>
        <Input disabled={supplierSource !== "其他"} placeholder={supplierSource === "其他" ? "请输入来源名称" : "选择其他后可填写"} />
      </CfgItem>
      <div className="recovery-customer-contacts">
        <div className="recovery-customer-contacts__title">联系方式</div>
        <CfgNestedItem className="recovery-fee-field" name="supplier_contact_name" label="公司名"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem className="recovery-fee-field" name="supplier_phone" label="手机号"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem className="recovery-fee-field" name="supplier_wechat" label="微信号"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem className="recovery-fee-field" name="supplier_qq" label="QQ"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
      </div>
      <CfgItem className="recovery-order-modal__note-field" name="supplier_note" label="供货方备注">
        <Input.TextArea rows={2} placeholder="可填写供货来源、特殊说明等" />
      </CfgItem>
      {props.participantExtras}
    </section>
  );
}
