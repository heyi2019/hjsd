import { Input, Typography } from "antd";
import { CfgItem } from "../../../shared/forms/ConfigurableField";
import { DateField, MoneyInput, Select, dateValueFromEvent, dateValueProps } from "../../../shared/ui";
import { requiredMoneyRules } from "../../../shared/lib/validators";
import type { ContractTableController } from "../useContractTableController";
import { InstallmentActionModal } from "./_shared";

export function PayModal({ controller }: { controller: ContractTableController }) {
  const { employees, payForm, payTarget, setPayTarget, submitPay, write } = controller;
  return (
    <InstallmentActionModal
      title={payTarget ? `分期收款 · ${payTarget.inst_no}` : "分期收款"}
      open={Boolean(payTarget)}
      onCancel={() => setPayTarget(null)}
      scope="INSTPAY"
      form={payForm}
      onFinish={submitPay}
      write={write}
      permission="order.event.post"
      submitLabel="确认收款"
      employees={employees}
      testIdSuffix="installment-pay"
    >
      <CfgItem name="period_no" label="期次（0=首付，留空按到期顺序）">
        <Select
          allowClear
          options={(payTarget?.schedules ?? []).map((schedule) => ({
            value: schedule.period_no,
            label: schedule.period_no === 0 ? "首付" : `第 ${schedule.period_no} 期`,
          }))}
        />
      </CfgItem>
      <CfgItem name="amount" label="本次实收" rules={requiredMoneyRules("本次实收")}>
        <MoneyInput />
      </CfgItem>
      <CfgItem
        name="paid_on"
        label="收款日期"
        rules={[{ required: true }]}
        getValueFromEvent={dateValueFromEvent}
        getValueProps={dateValueProps}
      >
        <DateField />
      </CfgItem>
    </InstallmentActionModal>
  );
}

export function SettleModal({ controller }: { controller: ContractTableController }) {
  const { employees, settleForm, settlePermission, settleTarget, setSettleTarget, submitSettleEarly, write } =
    controller;
  return (
    <InstallmentActionModal
      title={settleTarget ? `提前结清 · ${settleTarget.inst_no}` : "提前结清"}
      open={Boolean(settleTarget)}
      onCancel={() => setSettleTarget(null)}
      scope="INSTSETTLE"
      form={settleForm}
      onFinish={submitSettleEarly}
      write={write}
      permission={settlePermission}
      submitLabel="确认提前结清"
      employees={employees}
      intro={
        <Typography.Paragraph type="secondary">
          一次性收清全部剩余应收，逐期生成收款并关闭未来期次；不指定资金账户时按原收款资金账户入账。
        </Typography.Paragraph>
      }
      testIdSuffix="installment-settle"
    >
      <CfgItem
        name="paid_on"
        label="结清日期"
        rules={[{ required: true, message: "请选择结清日期" }]}
        getValueFromEvent={dateValueFromEvent}
        getValueProps={dateValueProps}
      >
        <DateField />
      </CfgItem>
      <CfgItem name="note" label="备注">
        <Input.TextArea rows={2} placeholder="可选" />
      </CfgItem>
    </InstallmentActionModal>
  );
}

export function WaiveModal({ controller }: { controller: ContractTableController }) {
  const { employees, waiveForm, waiveTarget, setWaiveTarget, submitWaive, write } = controller;
  return (
    <InstallmentActionModal
      title={waiveTarget ? `期次减免 · 第 ${waiveTarget.period_no} 期` : "期次减免"}
      open={Boolean(waiveTarget)}
      onCancel={() => setWaiveTarget(null)}
      scope="INSTWAIVE"
      form={waiveForm}
      onFinish={submitWaive}
      write={write}
      permission="order.update"
      submitLabel="确认减免"
      employees={employees}
      intro={
        <Typography.Paragraph type="secondary">
          已收款部分不可减免，减免额不得超过该期未收金额；减免后该期不再计入催收。
        </Typography.Paragraph>
      }
      testIdSuffix="installment-waive"
    >
      <CfgItem name="amount" label="减免金额" rules={requiredMoneyRules("减免金额")}>
        <MoneyInput />
      </CfgItem>
      <CfgItem
        name="waived_on"
        label="减免日期"
        rules={[{ required: true, message: "请选择减免日期" }]}
        getValueFromEvent={dateValueFromEvent}
        getValueProps={dateValueProps}
      >
        <DateField />
      </CfgItem>
      <CfgItem name="reason" label="减免原因" rules={[{ required: true, message: "请填写减免原因" }]}>
        <Input.TextArea rows={2} />
      </CfgItem>
    </InstallmentActionModal>
  );
}

export function ExtendModal({ controller }: { controller: ContractTableController }) {
  const { employees, extendForm, extendTarget, setExtendTarget, submitExtend, write } = controller;
  return (
    <InstallmentActionModal
      title={
        extendTarget
          ? `期次展期 · 第 ${extendTarget.period_no} 期（原到期 ${extendTarget.due_on}）`
          : "期次展期"
      }
      open={Boolean(extendTarget)}
      onCancel={() => setExtendTarget(null)}
      scope="INSTEXTEND"
      form={extendForm}
      onFinish={submitExtend}
      write={write}
      permission="order.update"
      submitLabel="确认展期"
      employees={employees}
      intro={
        <Typography.Paragraph type="secondary">
          新到期日必须晚于原到期日；逾期期次展期后回到 PENDING。
        </Typography.Paragraph>
      }
      testIdSuffix="installment-extend"
    >
      <CfgItem
        name="new_due_on"
        label="新到期日"
        rules={[{ required: true, message: "请选择新到期日" }]}
        getValueFromEvent={dateValueFromEvent}
        getValueProps={dateValueProps}
      >
        <DateField />
      </CfgItem>
      <CfgItem name="reason" label="展期原因" rules={[{ required: true, message: "请填写展期原因" }]}>
        <Input.TextArea rows={2} />
      </CfgItem>
    </InstallmentActionModal>
  );
}
