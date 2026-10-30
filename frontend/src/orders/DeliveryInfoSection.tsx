import { Form, Input } from "antd";
import { AdaptiveFormGrid, NestedFormSection, Select } from "../shared/ui";
import { CfgItem, sectionLabel } from "./ConfigurableField";
import { useOptionSet } from "../shared/lib/optionSets";
import type { EmployeeOption } from "../shared/api/catalog";
import { ResponsibleEmployeeSelect } from "./ResponsibleEmployeeSelect";
import "./DeliveryInfoSection.css";

/** 建单时已知的账号交接条件；实际交付完成仍在订单详情中登记。 */
export function DeliveryInfoSection(props: { showIntermediary?: boolean; employees?: EmployeeOption[] }) {
  const form = Form.useFormInstance();
  const deliveryTitle = sectionLabel("DELIVER", "交付信息");
  const intermediaryType = Form.useWatch("intermediary_type", form);
  const compensationEnabled = intermediaryType === "包赔";
  const platformOptions = useOptionSet("INTERMEDIARY_PLATFORM") ?? [];
  const intermediaryTypeOptions = useOptionSet("INTERMEDIARY_TYPE") ?? [];
  const compensationTypeOptions = useOptionSet("COMPENSATION_TYPE") ?? [];

  return (
    <NestedFormSection className="nested-form-section--card delivery-info-section" title={deliveryTitle}>
      <AdaptiveFormGrid>
        <CfgItem name="bound_phone" label="换绑手机号"><Input placeholder="可选填" /></CfgItem>
        <CfgItem name="bound_phone_owner" label="手机号绑定人"><Input placeholder="可选填" /></CfgItem>
        {props.showIntermediary ? <>
          <CfgItem name="intermediary_platform" label="交易平台" fixedLabel="交易平台"><Select options={platformOptions} placeholder="可选填" /></CfgItem>
          <CfgItem name="intermediary_type" label="中介类型"><Select options={intermediaryTypeOptions} placeholder="可选填" /></CfgItem>
          <CfgItem name="compensation_type" label="包赔类型" rules={compensationEnabled ? [{ required: true, message: "请选择包赔类型" }] : []}><Select options={compensationTypeOptions} disabled={!compensationEnabled} placeholder={compensationEnabled ? "请选择" : "选择包赔后可选"} /></CfgItem>
        </> : null}
        <ResponsibleEmployeeSelect className="delivery-info-section__responsibles" name="delivery_responsible_ids" label="交付负责人" employees={props.employees ?? []} />
      </AdaptiveFormGrid>
    </NestedFormSection>
  );
}
