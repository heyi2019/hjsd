import { Form, Input } from "antd";
import { AdaptiveFormGrid, MoneyInput, NestedFormField, NestedFormSection, Select } from "../shared/ui";
import { COMPENSATION_TYPE_OPTIONS, INTERMEDIARY_PLATFORM_OPTIONS, INTERMEDIARY_TYPE_OPTIONS } from "./recovery/recoveryConfig";

/** 回收、提号共用的附加费用字段；业务自身的主金额和提交事件由上层处理。 */
export function AdditionalFeeFields() {
  const form = Form.useFormInstance();
  const intermediaryFee = Form.useWatch("intermediary_fee", form);
  const intermediaryType = Form.useWatch("intermediary_type", form);
  const intermediaryEnabled = Number(intermediaryFee) > 0;
  const compensationEnabled = intermediaryType === "包赔";

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
        <NestedFormField className="recovery-fee-field" label="中介费"><Form.Item noStyle name="intermediary_fee"><MoneyInput className="recovery-fee-control" placeholder="金额" /></Form.Item></NestedFormField>
        <NestedFormField className="recovery-fee-field" label="经手平台"><Form.Item noStyle name="intermediary_platform" rules={intermediaryEnabled ? [{ required: true, message: "请选择经手平台" }] : []}><Select className="recovery-fee-control" disabled={!intermediaryEnabled} placeholder={intermediaryEnabled ? "请选择" : "填写中介费后可选"} options={INTERMEDIARY_PLATFORM_OPTIONS} /></Form.Item></NestedFormField>
        <NestedFormField className="recovery-fee-field" label="中介类型"><Form.Item noStyle name="intermediary_type" rules={intermediaryEnabled ? [{ required: true, message: "请选择中介类型" }] : []}><Select className="recovery-fee-control" disabled={!intermediaryEnabled} placeholder={intermediaryEnabled ? "请选择" : "填写中介费后可选"} options={INTERMEDIARY_TYPE_OPTIONS} /></Form.Item></NestedFormField>
        <NestedFormField className="recovery-fee-field" label="包赔类型"><Form.Item noStyle name="compensation_type" rules={compensationEnabled ? [{ required: true, message: "请选择包赔类型" }] : []}><Select className="recovery-fee-control" disabled={!compensationEnabled} placeholder={compensationEnabled ? "请选择" : "选择包赔后可选"} options={COMPENSATION_TYPE_OPTIONS} /></Form.Item></NestedFormField>
      </AdaptiveFormGrid>
      <AdaptiveFormGrid className="recovery-fee-row recovery-fee-row--other">
        <NestedFormField className="recovery-fee-field" label="其他"><Form.Item noStyle name="other_fee_name"><Input className="recovery-fee-control" placeholder="例如：打赏" /></Form.Item></NestedFormField>
        <NestedFormField className="recovery-fee-field" label="金额"><Form.Item noStyle name="other_fee_amount"><MoneyInput className="recovery-fee-control" placeholder="金额" /></Form.Item></NestedFormField>
        <NestedFormField className="recovery-fee-field" label="收款对象"><Form.Item noStyle name="other_fee_recipient"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
      </AdaptiveFormGrid>
    </NestedFormSection>
  );
}
