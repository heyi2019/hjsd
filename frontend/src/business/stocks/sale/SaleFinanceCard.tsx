import { Input, Radio } from "antd";
import type { SaleInstallmentPlan } from "../../../shared/api/installments.api";
import type { Pool } from "../../../shared/api/types/finance";
import { AdaptiveFormGrid, MoneyInput, Select } from "../../../shared/ui";
import { CfgItem } from "../../ConfigurableField";
import { InstallmentScheduleFields } from "../../InstallmentScheduleFields";

export function SaleFinanceCard({
  isConsignment,
  paymentMethod,
  saleAmount,
  downPayment,
  perPeriod,
  plan,
  pools,
}: {
  isConsignment: boolean;
  paymentMethod: string;
  saleAmount: unknown;
  downPayment: unknown;
  perPeriod: unknown;
  plan: SaleInstallmentPlan | null;
  pools: Pool[];
}) {
  return (
    <section className="inventory-sale-cashflow inventory-sale-cashflow--full-width" aria-labelledby="inventory-sale-cashflow-title">
      <div id="inventory-sale-cashflow-title" className="inventory-sale-cashflow__title">资金明细</div>
      <AdaptiveFormGrid>
        {isConsignment && (
          <CfgItem name="sale_amount" label="售出金额（仅记录）" rules={[{ validator: async (_, value) => { if (value !== undefined && value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error("请输入非负金额"); } }]}>
            <MoneyInput placeholder="代挂无买入价，此处仅作记录，不计入利润" />
          </CfgItem>
        )}
        <CfgItem name="amount" label={isConsignment ? "利润" : "售出金额"} rules={[{ required: true, message: isConsignment ? "请输入利润" : "请输入售出金额" }, { validator: async (_, value) => { if (value !== undefined && value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error("请输入非负金额"); } }]}>
          <MoneyInput placeholder={isConsignment ? "请输入利润（代挂佣金）" : "请输入金额"} />
        </CfgItem>
        {!isConsignment && (
          <CfgItem name="payment_method" label="付款方式" initialValue="FULL">
            <Radio.Group optionType="button" buttonStyle="solid" />
          </CfgItem>
        )}
        {paymentMethod === "FULL" ? (
          <>
            <CfgItem name="pool_id" label="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}>
              <Select placeholder="资金账户" options={pools.map((pool) => ({ value: pool.id, label: pool.name }))} notFoundContent="暂无可用资金账户" />
            </CfgItem>
            <CfgItem name="cashflow_note" label="资金明细备注">
              <Input placeholder="可选填" />
            </CfgItem>
          </>
        ) : (
          <div className="inventory-sale-installment-fields inventory-sale-installment-fields--grid">
            <p className="muted">出售时选择分期，系统会建立对应的售出分期合同，并将账号标记为“分期中”。</p>
            <CfgItem name="down_payment" label="首付金额" initialValue="0" rules={[{ validator: async (_, value) => { if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > Number(saleAmount)) throw new Error("首付不能为负数或超过售出金额"); } }]}><MoneyInput placeholder="没有首付填 0" /></CfgItem>
            <CfgItem name="pool_id" label="资金账户" rules={downPayment != null && Number(downPayment) > 0 ? [{ required: true, message: "请选择首付收款资金账户" }] : []}>
              <Select placeholder="首付收款资金账户" options={pools.map((pool) => ({ value: pool.id, label: pool.name }))} notFoundContent="暂无可用资金账户" />
            </CfgItem>
            <CfgItem name="service_fee" label="分期服务费总额" initialValue="0" rules={[{ validator: async (_, value) => { if (!Number.isFinite(Number(value)) || Number(value) < 0) throw new Error("服务费不能为负数"); } }]}><MoneyInput placeholder="可选填" /></CfgItem>
            <CfgItem name="periods" label="分期期数" initialValue={1} rules={[{ validator: async (_, value) => { if (!Number.isInteger(Number(value)) || Number(value) <= 0) throw new Error("期数必须为正整数"); } }]}><Input inputMode="numeric" placeholder="请输入期数" /></CfgItem>
            <CfgItem name="per_period_service_fee" label="每期服务费" rules={[{ validator: async (_, value) => { if (value !== undefined && value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error("每期服务费必须为非负金额"); } }]}><MoneyInput placeholder="按服务费总额/期数计算" /></CfgItem>
            <CfgItem name="per_period" label="每期金额" rules={[{ required: true, message: "请输入每期金额" }, { validator: async () => { if (plan?.per_period_matches === false) throw new Error("每期金额与分期总额不匹配"); } }]} extra={plan && perPeriod != null ? `最后一期：${plan.last_period} 元` : undefined}><MoneyInput placeholder="请输入每期应收" /></CfgItem>
            <div className="inventory-sale-plan">
              <div className="inventory-sale-plan__title">分期计划</div>
              <InstallmentScheduleFields name="installment_schedule" />
            </div>
          </div>
        )}
      </AdaptiveFormGrid>
    </section>
  );
}
