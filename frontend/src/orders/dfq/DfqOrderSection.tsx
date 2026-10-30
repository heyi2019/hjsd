import { appMessage } from "../../shared/ui/appFeedback";
import { Form, Input } from "antd";
import { useEffect, useRef } from "react";
import type { EmployeeOption, GameTypeOption, Pool } from "../../shared/api/catalog";
import { AdaptiveFormGrid, MoneyInput, NestedFormField, NestedFormSection, Select } from "../../shared/ui";
import { RecoveryAccountSection } from "../recovery/RecoveryAccountSection";
import { CfgItem, CfgNestedItem, CustomFieldSection, sectionLabel } from "../ConfigurableField";
import { InstallmentScheduleFields } from "../InstallmentScheduleFields";
import { CustomerSourceFields } from "../CustomerSourceInput";
import "./DfqOrderSection.css";

function DfqInstallmentInfo() {
  const form = Form.useFormInstance();
  const purchasePrice = Form.useWatch("recovery_price", form);
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
    <AdaptiveFormGrid className="dfq-installment-grid">
      <CfgNestedItem noStyle={false} name="recovery_price" label="账号号价" rules={[{ required: true, message: "请输入账号号价" }, { validator: async (_, value) => { if (value !== undefined && value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error("请输入非负金额"); } }]}><MoneyInput placeholder="账号全款基础价格" /></CfgNestedItem>
      <NestedFormField label="借款本金"><Form.Item noStyle name="dfq_total_amount"><MoneyInput placeholder="客户借款的剩余号款" readOnly /></Form.Item></NestedFormField>
      <CfgNestedItem noStyle={false} name="dfq_down_payment" label="客户首付款" rules={[{ validator: async (_, value) => { if (value !== undefined && value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > Number(form.getFieldValue("recovery_price")))) throw new Error("首付款不能为负数或超过账号号价"); } }]}><MoneyInput placeholder="客户已支付的部分号款" /></CfgNestedItem>
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

export function DfqOrderSection(props: { pools: Pool[]; gameTypes?: GameTypeOption[]; employees?: EmployeeOption[] }) {
  const form = Form.useFormInstance();
  const participantTitle = sectionLabel("PARTICIPANT", "分期客户");

  return (
    <>
      <RecoveryAccountSection accountExtras={<CustomFieldSection section="ACCOUNT_PRODUCT" testIdSuffix="account" />} gameTypes={props.gameTypes} employees={props.employees} businessResponsibleLabel="代分期负责人">
        <NestedFormSection className="nested-form-section--card dfq-section" title="借款与分期信息" description="登记客户首付款、借款本金及后续分期还款">
          <DfqInstallmentInfo />
          <CustomFieldSection section="BUSINESS" testIdSuffix="business" />
        </NestedFormSection>
        <NestedFormSection className="nested-form-section--card dfq-section" title="付款信息">
          <AdaptiveFormGrid>
            <CfgNestedItem name="payment_pool_id" label="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}><Select placeholder="请选择资金账户" options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} /></CfgNestedItem>
            <CfgNestedItem name="payment_note" label="资金流水备注"><Input placeholder="可选填" /></CfgNestedItem>
          </AdaptiveFormGrid>
          <CustomFieldSection section="FINANCE" testIdSuffix="finance" />
        </NestedFormSection>
      </RecoveryAccountSection>

      <section className="dfq-customer-section recovery-customer-fields" aria-labelledby="dfq-customer-info-title">
        <div id="dfq-customer-info-title" className="recovery-customer-fields__title">{participantTitle}</div>
        <CfgItem className="recovery-order-modal__party-field" name="customer_nickname" label="客户昵称" rules={[{ required: true, message: "客户昵称必填" }]}><Input placeholder="请输入客户昵称" /></CfgItem>
        <CustomerSourceFields name="customer_source" otherName="customer_source_other" />
        <div className="recovery-customer-contacts">
          <div className="recovery-customer-contacts__title">联系方式</div>
          <CfgNestedItem className="recovery-fee-field" name="customer_contact_name" label="姓名"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem className="recovery-fee-field" name="customer_phone" label="手机号"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem className="recovery-fee-field" name="customer_wechat" label="微信号"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
          <CfgNestedItem className="recovery-fee-field" name="customer_qq" label="QQ"><Input className="recovery-fee-control" placeholder="可选填" /></CfgNestedItem>
        </div>
        <CustomFieldSection section="PARTICIPANT" testIdSuffix="participant" />
      </section>
      <NestedFormSection className="nested-form-section--card dfq-section" title="分期计划" description="每期到期日可单独自定义">
        <InstallmentScheduleFields name="dfq_schedule" />
      </NestedFormSection>
      <NestedFormSection className="nested-form-section--card dfq-section" title="补充信息">
        <CustomFieldSection section="DELIVER" testIdSuffix="deliver" />
        <CfgItem className="recovery-order-modal__note-field" name="note" label="分期备注"><Input.TextArea rows={2} placeholder="可选填" /></CfgItem>
      </NestedFormSection>
    </>
  );
}
