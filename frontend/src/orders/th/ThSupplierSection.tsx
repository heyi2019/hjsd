import { Input } from "antd";
import type { ReactNode } from "react";
import type { Counterparty } from "../../shared/api/catalog";
import { BusinessRegistrationGroup, BusinessRegistrationSection } from "../../shared/ui";
import { CfgItem, CfgNestedItem, sectionLabel } from "../ConfigurableField";
import { PartyMasterSelect } from "../PartyMasterSelect";
import "./ThSupplierSection.css";

/** 提号只从合作伙伴主数据选择，不在建单时填写客户或来源分类。 */
export function ThSupplierSection(props: {
  counterparties: Counterparty[];
  participantExtras?: ReactNode;
  onCreateSupplier?: () => void;
}) {
  const participantTitle = sectionLabel("PARTICIPANT", "合作伙伴信息");
  const supplierOptions = props.counterparties
    .filter((item) => item.type === "SUPPLIER" && item.status === "ACTIVE")
    .map((item) => ({ value: item.id, label: `${item.display_name}（${item.counterparty_no}）` }));
  return (
    <BusinessRegistrationSection
      className="th-supplier-section"
      title={participantTitle}
    >
      <CfgItem name="supplier_counterparty_id" label="合作伙伴" rules={[{ required: true, message: "请选择合作伙伴" }]}>
        <PartyMasterSelect
          options={supplierOptions}
          placeholder="请选择合作伙伴主数据"
          createLabel="新建合作伙伴"
          emptyText="暂无合作伙伴，可直接新建"
          onCreate={props.onCreateSupplier ?? (() => undefined)}
        />
      </CfgItem>
      <BusinessRegistrationGroup className="supplier-contacts" title="联系方式">
        <CfgNestedItem className="supplier-note" name="supplier_note" fixedLabel="合作伙伴备注"><Input placeholder="可选填" /></CfgNestedItem>
      </BusinessRegistrationGroup>
      {props.participantExtras}
    </BusinessRegistrationSection>
  );
}
