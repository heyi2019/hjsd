import { DatePicker, Form, Input } from "antd";
import { useEffect, useRef } from "react";
import type { GameTypeOption, Pool } from "../../shared/api/catalog";
import { AdaptiveFormGrid, MoneyInput, NestedFormField, NestedFormSection, Select } from "../../shared/ui";
import { RecoveryAccountSection } from "../recovery/RecoveryAccountSection";
import { CUSTOMER_SOURCE_OPTIONS } from "../recovery/recoveryConfig";
import "./DfqOrderSection.css";

function DfqInstallmentInfo() {
  const form = Form.useFormInstance();
  const totalAmount = Form.useWatch("dfq_total_amount", form);
  const serviceFee = Form.useWatch("dfq_service_fee", form);
  const periods = Form.useWatch("dfq_periods", form);
  const periodServiceFee = Form.useWatch("dfq_period_service_fee", form);
  const periodAmount = Form.useWatch("dfq_period_amount", form);
  const lastAutoValue = useRef<number | undefined>();
  const lastAutoAmount = useRef<number | undefined>();

  useEffect(() => {
    const total = Number(serviceFee);
    const count = Number(periods);
    if (!Number.isFinite(total) || !Number.isFinite(count) || count <= 0) return;

    const nextValue = Number((total / count).toFixed(2));
    const isAutoValue = periodServiceFee === undefined || periodServiceFee === lastAutoValue.current;
    if (isAutoValue) {
      form.setFieldValue("dfq_period_service_fee", nextValue);
      lastAutoValue.current = nextValue;
    }
  }, [form, periodServiceFee, periods, serviceFee]);

  useEffect(() => {
    const remainingAmount = Number(totalAmount);
    const fee = Number(serviceFee);
    const count = Number(periods);
    if (!Number.isFinite(remainingAmount) || !Number.isFinite(fee) || !Number.isFinite(count) || count <= 0) return;

    const nextAmount = Number(((remainingAmount + fee) / count).toFixed(2));
    const isAutoValue = periodAmount === undefined || periodAmount === lastAutoAmount.current;
    if (isAutoValue) {
      form.setFieldValue("dfq_period_amount", nextAmount);
      lastAutoAmount.current = nextAmount;
    }
  }, [form, periodAmount, periods, serviceFee, totalAmount]);

  return (
    <AdaptiveFormGrid>
      <NestedFormField label="账号号价"><Form.Item noStyle name="dfq_purchase_price"><MoneyInput placeholder="账号全款基础价格" /></Form.Item></NestedFormField>
      <NestedFormField label="代分期金额"><Form.Item noStyle name="dfq_total_amount"><MoneyInput placeholder="客户未付的剩余号款" /></Form.Item></NestedFormField>
      <NestedFormField label="客户已付金额"><Form.Item noStyle name="dfq_down_payment"><MoneyInput placeholder="客户已支付的部分号款" /></Form.Item></NestedFormField>
      <NestedFormField label="手续费总额"><Form.Item noStyle name="dfq_service_fee"><MoneyInput placeholder="代付服务手续费" /></Form.Item></NestedFormField>
      <NestedFormField label="分期期数"><Form.Item noStyle name="dfq_periods" initialValue={1}><Input className="dfq-periods-control" inputMode="numeric" placeholder="请输入期数" /></Form.Item></NestedFormField>
      <NestedFormField label="每期手续费"><Form.Item noStyle name="dfq_period_service_fee"><MoneyInput placeholder="按手续费总额/期数计算，可修改" /></Form.Item></NestedFormField>
      <NestedFormField label="每期金额"><Form.Item noStyle name="dfq_period_amount"><MoneyInput placeholder="请输入金额" /></Form.Item></NestedFormField>
    </AdaptiveFormGrid>
  );
}

export function DfqOrderSection(props: { pools: Pool[]; gameTypes?: GameTypeOption[] }) {

  return (
    <>
      <RecoveryAccountSection fieldNames={{
        gameType: "dfq_game_type", gameAccount: "dfq_game_account", gamePassword: "dfq_game_password",
        channelRegion: "dfq_channel_region", boundPhone: "dfq_bound_phone", hasSecondary: "dfq_has_secondary", accountNote: "dfq_account_note",
      }} gameTypes={props.gameTypes}>
        <NestedFormSection className="nested-form-section--card dfq-section" title="分期信息" description="客户已支付部分号款，系统代付剩余号款，后续按期向客户收回">
          <DfqInstallmentInfo />
        </NestedFormSection>
        <NestedFormSection className="nested-form-section--card dfq-section" title="分期计划" description="每期到期日可单独自定义">
          <Form.List name="dfq_schedule" initialValue={[{}]}>
            {(fields, { add, remove }) => (
              <div className="dfq-schedule-list">
                {fields.map((field, index) => (
                  <div className="dfq-schedule-row" key={field.key}>
                    <span className="dfq-schedule-row__period">第 {index + 1} 期</span>
                    <Form.Item name={[field.name, "due_on"]} label="到期日" rules={[{ required: true, message: "请选择到期日" }]}><DatePicker placeholder="请选择日期" /></Form.Item>
                    <Form.Item name={[field.name, "service_fee_rate"]} label="本期费率"><Input suffix="%" inputMode="decimal" placeholder="可选填" /></Form.Item>
                    <Form.Item name={[field.name, "note"]} label="期次备注"><Input placeholder="可选填" /></Form.Item>
                    {fields.length > 1 && <button type="button" className="dfq-schedule-row__remove" onClick={() => remove(field.name)}>删除</button>}
                  </div>
                ))}
                <button type="button" className="dfq-schedule-list__add" onClick={() => add({})}>+ 添加期次</button>
              </div>
            )}
          </Form.List>
        </NestedFormSection>
        <NestedFormSection className="nested-form-section--card dfq-section" title="付款信息">
          <AdaptiveFormGrid>
            <NestedFormField label="付款资金账户"><Form.Item noStyle name="dfq_payment_pool_id" rules={[{ required: true, message: "请选择资金账户" }]}><Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} /></Form.Item></NestedFormField>
            <NestedFormField label="付款对象"><Form.Item noStyle name="dfq_payment_recipient" initialValue="供货方"><Input /></Form.Item></NestedFormField>
            <NestedFormField label="资金流水备注"><Form.Item noStyle name="dfq_payment_note"><Input placeholder="可选填" /></Form.Item></NestedFormField>
          </AdaptiveFormGrid>
        </NestedFormSection>
      </RecoveryAccountSection>

      <section className="dfq-customer-section recovery-customer-fields" aria-labelledby="dfq-customer-info-title">
        <div id="dfq-customer-info-title" className="recovery-customer-fields__title">分期客户</div>
        <Form.Item className="recovery-order-modal__party-field" name="dfq_customer_nickname" label="客户昵称" rules={[{ required: true, message: "客户昵称必填" }]}><Input placeholder="请输入客户昵称" /></Form.Item>
        <Form.Item className="recovery-order-modal__party-field" name="dfq_customer_source" label="客户来源" rules={[{ required: true, message: "请选择客户来源" }]}><Select placeholder="请选择客户来源" options={CUSTOMER_SOURCE_OPTIONS} /></Form.Item>
        <div className="recovery-customer-contacts">
          <div className="recovery-customer-contacts__title">联系方式</div>
          <NestedFormField className="recovery-fee-field" label="姓名"><Form.Item noStyle name="dfq_customer_contact"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
          <NestedFormField className="recovery-fee-field" label="手机号"><Form.Item noStyle name="dfq_customer_phone"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
          <NestedFormField className="recovery-fee-field" label="微信号"><Form.Item noStyle name="dfq_customer_wechat"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
          <NestedFormField className="recovery-fee-field" label="QQ"><Form.Item noStyle name="dfq_customer_qq"><Input className="recovery-fee-control" placeholder="可选填" /></Form.Item></NestedFormField>
        </div>
        <Form.Item className="recovery-order-modal__note-field" name="dfq_note" label="分期备注"><Input.TextArea rows={2} placeholder="可选填" /></Form.Item>
      </section>
    </>
  );
}
