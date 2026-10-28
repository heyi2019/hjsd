import { Form, Input } from "antd";
import { AdaptiveFormGrid, MoneyInput, NestedFormSection, Select } from "../shared/ui";
import { CfgNestedItem } from "./ConfigurableField";
import { useOptionSet } from "../shared/lib/optionSets";

/** 回收、提号共用的附加费用字段；业务自身的主金额和提交事件由上层处理。 */
export function AdditionalFeeFields() {
  const form = Form.useFormInstance();
  const intermediaryFee = Form.useWatch("intermediary_fee", form);
  const intermediaryType = Form.useWatch("intermediary_type", form);
  const intermediaryEnabled = Number(intermediaryFee) > 0;
  const compensationEnabled = intermediaryType === "包赔";
  const intermediaryPlatformOptions = useOptionSet("INTERMEDIARY_PLATFORM") ?? [];
  const intermediaryTypeOptions = useOptionSet("INTERMEDIARY_TYPE") ?? [];
  const compensationTypeOptions = useOptionSet("COMPENSATION_TYPE") ?? [];

  return (
    <NestedFormSection
      className="nested-form-section--card recovery-fee-card"
      headerClassName="recovery-fee-card__head"
      titleClassName="recovery-fee-card__label"
      descriptionClassName="recovery-fee-card__desc"
      title="附加费用"
      description="没有发生就留空，不影响主金额"
    >
      <AdaptiveFormGrid className="recovery-fee-row">
        <CfgNestedItem className="recovery-fee-field" name="intermediary_fee" label="中介费"><MoneyInput className="recovery-fee-control" placeholder="金额" /></CfgNestedItem>
        <CfgNestedItem className="recovery-fee-field" name="intermediary_platform" label="经手平台" rules={intermediaryEnabled ? [{ required: true, message: "请选择经手平台" }] : []}><Select className="recovery-fee-control" options={intermediaryPlatformOptions} disabled={!intermediaryEnabled} placeholder={intermediaryEnabled ? "请选择" : "填写中介费后可选"} /></CfgNestedItem>
        <CfgNestedItem className="recovery-fee-field" name="intermediary_type" label="中介类型" rules={intermediaryEnabled ? [{ required: true, message: "请选择中介类型" }] : []}><Select className="recovery-fee-control" options={intermediaryTypeOptions} disabled={!intermediaryEnabled} placeholder={intermediaryEnabled ? "请选择" : "填写中介费后可选"} /></CfgNestedItem>
        <CfgNestedItem className="recovery-fee-field" name="compensation_type" label="包赔类型" rules={compensationEnabled ? [{ required: true, message: "请选择包赔类型" }] : []}><Select className="recovery-fee-control" options={compensationTypeOptions} disabled={!compensationEnabled} placeholder={compensationEnabled ? "请选择" : "选择包赔后可选"} /></CfgNestedItem>
      </AdaptiveFormGrid>
      <AdaptiveFormGrid className="recovery-fee-row recovery-fee-row--other">
        <CfgNestedItem className="recovery-fee-field" name="other_fee_name" label="其他"><Input className="recovery-fee-control" placeholder="例如：打赏" /></CfgNestedItem>
        <CfgNestedItem className="recovery-fee-field" name="other_fee_amount" label="金额"><MoneyInput className="recovery-fee-control" placeholder="金额" /></CfgNestedItem>
        <CfgNestedItem className="recovery-fee-field" name="other_fee_recipient" label="收款对象"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
        <CfgNestedItem className="recovery-fee-field" name="design_fee" label="设计费"><MoneyInput className="recovery-fee-control" aria-label="设计费" placeholder="金额" /></CfgNestedItem>
      </AdaptiveFormGrid>
    </NestedFormSection>
  );
}
