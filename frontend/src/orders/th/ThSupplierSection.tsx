import { Form, Input } from "antd";
import type { ReactNode } from "react";
import type { Counterparty } from "../../shared/api/catalog";
import { BusinessRegistrationGroup, BusinessRegistrationSection } from "../../shared/ui";
import { CfgItem, CfgNestedItem, sectionLabel } from "../ConfigurableField";
import { PartyMasterSelect } from "../PartyMasterSelect";
import "./ThSupplierSection.css";

/** 提号支持合作伙伴主数据联想，也允许直接输入新合作伙伴名称。 */
export function ThSupplierSection(props: {
  counterparties: Counterparty[];
  participantExtras?: ReactNode;
  onCreateSupplier?: () => void;
}) {
  const form = Form.useFormInstance();
  const participantTitle = sectionLabel("PARTICIPANT", "合作伙伴信息");
  const supplierOptions = props.counterparties
    .filter((item) => item.type === "SUPPLIER" && item.status === "ACTIVE")
    .map((item) => ({ value: item.id, label: `${item.display_name}（${item.counterparty_no}）` }));
  return (
    <BusinessRegistrationSection
      className="th-supplier-section"
      title={participantTitle}
    >
      <CfgItem
        name="supplier_counterparty_id"
        label="合作伙伴"
        rules={[{ validator: async (_rule, value) => {
          if (Number(value) > 0 || String(form.getFieldValue("supplier_lookup") ?? "").trim()) return;
          throw new Error("请输入合作伙伴名称或选择已有合作伙伴");
        } }]}
      >
        <PartyMasterSelect
          options={supplierOptions}
          placeholder="输入合作伙伴名称，或选择已有合作伙伴"
          createLabel="新建合作伙伴"
          emptyText="暂无合作伙伴，可直接新建"
          onCreate={props.onCreateSupplier ?? (() => undefined)}
          onSearch={(value) => {
            if (!value.trim()) return;
            form.setFieldValue("supplier_lookup", value);
            if (form.getFieldValue("supplier_counterparty_id") != null) form.setFieldValue("supplier_counterparty_id", undefined);
          }}
          onClear={() => form.setFieldsValue({ supplier_counterparty_id: undefined, supplier_lookup: undefined })}
          onChange={(value) => {
            const supplier = props.counterparties.find((item) => item.id === Number(value));
            if (!supplier) return;
            form.setFieldsValue({
              supplier_counterparty_id: supplier.id,
              supplier_lookup: undefined,
              supplier_contact_name: supplier.contact_name ?? undefined,
              supplier_phone: supplier.phone ?? undefined,
              supplier_wechat: supplier.wechat ?? undefined,
              supplier_qq: supplier.qq ?? undefined,
              supplier_note: supplier.note ?? undefined,
            });
          }}
        />
      </CfgItem>
      <Form.Item name="supplier_lookup" hidden><Input /></Form.Item>
      <BusinessRegistrationGroup className="supplier-contacts" title="联系方式">
        <CfgNestedItem name="supplier_contact_name" label="联系人"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem name="supplier_phone" label="手机号"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem name="supplier_wechat" label="微信号"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem name="supplier_qq" label="QQ"><Input placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem className="supplier-note" name="supplier_note" fixedLabel="合作伙伴备注"><Input placeholder="可选填" /></CfgNestedItem>
      </BusinessRegistrationGroup>
      {props.participantExtras}
    </BusinessRegistrationSection>
  );
}
