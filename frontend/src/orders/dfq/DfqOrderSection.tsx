import { appMessage, appModal } from "../../shared/ui/appFeedback";
import { DatePicker, Form, Input, Modal } from "antd";
import { useEffect, useRef } from "react";
import type { GameTypeOption, Pool } from "../../shared/api/catalog";
import { AdaptiveFormGrid, MoneyInput, NestedFormField, NestedFormSection, Select } from "../../shared/ui";
import { RecoveryAccountSection } from "../recovery/RecoveryAccountSection";
import { CfgItem, CfgNestedItem } from "../ConfigurableField";
import "./DfqOrderSection.css";

function DfqInstallmentInfo() {
  const form = Form.useFormInstance();
  const purchasePrice = Form.useWatch("dfq_purchase_price", form);
  const downPayment = Form.useWatch("dfq_down_payment", form);
  const totalAmount = Form.useWatch("dfq_total_amount", form);
  const serviceFee = Form.useWatch("dfq_service_fee", form);
  const periods = Form.useWatch("dfq_periods", form);
  const periodServiceFee = Form.useWatch("dfq_period_service_fee", form);
  const periodAmount = Form.useWatch("dfq_period_amount", form);
  const lastAutoValue = useRef<number | undefined>();
  const lastAutoAmount = useRef<number | undefined>();

  useEffect(() => {
    if (purchasePrice === undefined || purchasePrice === "") {
      form.setFieldValue("dfq_total_amount", undefined);
      return;
    }
    const price = Number(purchasePrice);
    const down = Number(downPayment || 0);
    if (Number.isFinite(price) && Number.isFinite(down) && price >= 0 && down >= 0 && down <= price) {
      form.setFieldValue("dfq_total_amount", Number((price - down).toFixed(2)));
    } else {
      form.setFieldValue("dfq_total_amount", undefined);
    }
  }, [form, purchasePrice, downPayment]);

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
    const fee = Number(serviceFee || 0);
    const count = Number(periods);
    if (!Number.isFinite(remainingAmount) || !Number.isFinite(fee) || !Number.isFinite(count) || count <= 0) return;

    const nextAmount = Math.ceil((Math.round(remainingAmount * 100) + Math.round(fee * 100)) / count) / 100;
    const isAutoValue = periodAmount === undefined || periodAmount === lastAutoAmount.current;
    if (isAutoValue) {
      form.setFieldValue("dfq_period_amount", nextAmount);
      lastAutoAmount.current = nextAmount;
    }
  }, [form, periodAmount, periods, serviceFee, totalAmount]);

  return (
    <AdaptiveFormGrid>
      <CfgNestedItem noStyle={false} name="dfq_purchase_price" label="账号号价" rules={[{ required: true, message: "请输入账号号价" }, { validator: async (_, value) => { if (value !== undefined && value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error("请输入非负金额"); } }]}><MoneyInput placeholder="账号全款基础价格" /></CfgNestedItem>
      <NestedFormField label="借款本金"><Form.Item noStyle name="dfq_total_amount"><MoneyInput placeholder="客户借款的剩余号款" readOnly /></Form.Item></NestedFormField>
      <CfgNestedItem noStyle={false} name="dfq_down_payment" label="客户首付款" rules={[{ validator: async (_, value) => { if (value !== undefined && value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > Number(form.getFieldValue("dfq_purchase_price")))) throw new Error("首付款不能为负数或超过账号号价"); } }]}><MoneyInput placeholder="客户已支付的部分号款" /></CfgNestedItem>
      <CfgNestedItem noStyle={false} name="dfq_service_fee" label="手续费总额" rules={[{ validator: async (_, value) => { if (value !== undefined && value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error("手续费必须为非负金额"); } }]}><MoneyInput placeholder="分期服务手续费" /></CfgNestedItem>
      <CfgNestedItem noStyle={false} name="dfq_periods" label="分期期数" initialValue={1} rules={[{ validator: async (_, value) => {
        const count = Number(value);
        if (!Number.isInteger(count) || count <= 0 || count > 120) throw new Error("期数必须为 1 至 120 的整数");
        if ((form.getFieldValue("dfq_schedule") ?? []).length !== count) throw new Error("分期计划数量须与期数一致");
      } }]}><Input className="dfq-periods-control" inputMode="numeric" placeholder="请输入期数" /></CfgNestedItem>
      <CfgNestedItem noStyle={false} name="dfq_period_service_fee" label="每期手续费" rules={[{ validator: async (_, value) => { if (value !== undefined && value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error("每期手续费必须为非负金额"); } }]}><MoneyInput placeholder="按手续费总额/期数计算，可修改" /></CfgNestedItem>
      <CfgNestedItem noStyle={false} name="dfq_period_amount" label="每期金额" rules={[{ validator: async (_, value) => {
        const count = Number(periods), total = Number(totalAmount) + Number(serviceFee || 0), amount = Number(value);
        if (!Number.isFinite(amount) || amount < 0 || (count > 0 && (amount * count + 0.001 < Number(totalAmount) || amount * (count - 1) > total + 0.001))) throw new Error("每期金额与分期总额不匹配");
      } }]}><MoneyInput placeholder="请输入金额" /></CfgNestedItem>
      {totalAmount != null && Number(periods) > 0 && periodAmount != null && Number.isFinite(Number(periodAmount)) && <span>最后一期：{((Math.round((Number(totalAmount) + Number(serviceFee || 0)) * 100) - Math.round(Number(periodAmount) * 100) * (Number(periods) - 1)) / 100).toFixed(2)} 元</span>}
    </AdaptiveFormGrid>
  );
}

export function DfqOrderSection(props: { pools: Pool[]; gameTypes?: GameTypeOption[] }) {
  const form = Form.useFormInstance();

  return (
    <>
      <RecoveryAccountSection fieldNames={{
        gameType: "dfq_game_type", gameAccount: "dfq_game_account", gamePassword: "dfq_game_password",
        channelRegion: "dfq_channel_region", boundPhone: "dfq_bound_phone", hasSecondary: "dfq_has_secondary", accountNote: "dfq_account_note",
      }} gameTypes={props.gameTypes}>
        <NestedFormSection className="nested-form-section--card dfq-section" title="借款与分期信息" description="登记客户首付款、借款本金及后续分期还款">
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
                    {fields.length > 1 && <button type="button" className="dfq-schedule-row__remove" onClick={() => {
                      if (form.getFieldValue(["dfq_schedule", field.name, "due_on"])) appModal.confirm({ title: "删除已填写的期次？", okText: "删除", cancelText: "取消", onOk: () => remove(field.name) });
                      else remove(field.name);
                    }}>删除</button>}
                  </div>
                ))}
                <button type="button" className="dfq-schedule-list__add" onClick={() => add({})}>+ 添加期次</button>
              </div>
            )}
          </Form.List>
        </NestedFormSection>
        <NestedFormSection className="nested-form-section--card dfq-section" title="付款信息">
          <AdaptiveFormGrid>
            <CfgNestedItem name="dfq_payment_pool_id" label="付款资金账户" rules={[{ required: true, message: "请选择资金账户" }]}><Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} /></CfgNestedItem>
            <CfgNestedItem name="dfq_payment_recipient" label="付款对象" initialValue="供货方"><Input /></CfgNestedItem>
            <CfgNestedItem name="dfq_payment_note" label="资金流水备注"><Input placeholder="可选填" /></CfgNestedItem>
          </AdaptiveFormGrid>
        </NestedFormSection>
      </RecoveryAccountSection>

      <section className="dfq-customer-section recovery-customer-fields" aria-labelledby="dfq-customer-info-title">
        <div id="dfq-customer-info-title" className="recovery-customer-fields__title">分期客户</div>
        <CfgItem className="recovery-order-modal__party-field" name="dfq_customer_nickname" label="客户昵称" rules={[{ required: true, message: "客户昵称必填" }]}><Input placeholder="请输入客户昵称" /></CfgItem>
        <CfgItem className="recovery-order-modal__party-field" name="dfq_customer_source" label="客户来源"><Input placeholder="可选填，如：转介绍 / 抖音 / 老客户" /></CfgItem>
        <div className="recovery-customer-contacts">
          <div className="recovery-customer-contacts__title">联系方式</div>
          <CfgNestedItem className="recovery-fee-field" name="dfq_customer_contact" label="姓名"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem className="recovery-fee-field" name="dfq_customer_phone" label="手机号"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem className="recovery-fee-field" name="dfq_customer_wechat" label="微信号"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem className="recovery-fee-field" name="dfq_customer_qq" label="QQ"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
        </div>
        <CfgItem className="recovery-order-modal__note-field" name="dfq_note" label="分期备注"><Input.TextArea rows={2} placeholder="可选填" /></CfgItem>
      </section>
    </>
  );
}
