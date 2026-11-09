import { Form, Input } from "antd";
import type { ReactNode } from "react";
import type { Counterparty } from "../../shared/api/catalog";
import { BusinessRegistrationGroup, BusinessRegistrationSection, PermissionButton, Select } from "../../shared/ui";
import { CfgItem, CfgNestedItem, sectionLabel } from "../ConfigurableField";

/** 提号只从合作方主数据选择供货方，不在建单时填写客户或来源分类。 */
export function ThSupplierSection(props: {
  counterparties: Counterparty[];
  participantExtras?: ReactNode;
  onCreateSupplier?: () => void;
}) {
  const participantTitle = sectionLabel("PARTICIPANT", "供货方信息");
  const supplierOptions = props.counterparties
    .filter((item) => item.type === "SUPPLIER" && item.status === "ACTIVE")
    .map((item) => ({ value: item.id, label: `${item.display_name}（${item.counterparty_no}）` }));
  return (
    <BusinessRegistrationSection
      className="th-supplier-section"
      title={participantTitle}
      action={props.onCreateSupplier ? (
        <PermissionButton permission="counterparty.manage" size="small" onClick={props.onCreateSupplier}>
          新建供货方
        </PermissionButton>
      ) : undefined}
    >
      <CfgItem name="supplier_counterparty_id" label="供货合作伙伴" rules={[{ required: true, message: "请选择供货合作伙伴" }]}>
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="请选择合作伙伴主数据"
          options={supplierOptions}
          notFoundContent="暂无供货方，可直接新建"
        />
      </CfgItem>
      <BusinessRegistrationGroup className="supplier-contacts" title="联系方式">
        <CfgNestedItem name="supplier_note" label="供货方备注"><Input.TextArea rows={2} placeholder="可填写本单供货说明" /></CfgNestedItem>
      </BusinessRegistrationGroup>
      {props.participantExtras}
    </BusinessRegistrationSection>
  );
}
