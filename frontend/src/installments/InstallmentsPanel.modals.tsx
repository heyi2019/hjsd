import { Input, Typography } from "antd";
import type { FormInstance } from "antd";
import type { ReactNode } from "react";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../orders/ConfigurableField";
import {
  BusinessActionModal,
  BusinessRegistrationForm,
  DateField,
  InlineError,
  MoneyInput,
  PermissionButton,
  Select,
  dateValueFromEvent,
  dateValueProps,
} from "../shared/ui";
import type { NormalizedError } from "../shared/api/client";
import type { Permission } from "../shared/state/session";
import { requiredMoneyRules } from "../shared/lib/validators";
import type { ContractTableController } from "./useContractTableController";
import { ResponsibleEmployeeSelect } from "../orders/ResponsibleEmployeeSelect";

const Modal = BusinessActionModal;

type WriteState = { error: NormalizedError | null; pending: boolean };

interface InstallmentActionModalProps {
  title: string;
  open: boolean;
  onCancel: () => void;
  scope: string;
  form: FormInstance;
  onFinish: (values: Record<string, unknown>) => void;
  write: WriteState;
  permission: Permission;
  submitLabel: string;
  danger?: boolean;
  intro?: ReactNode;
  outro?: ReactNode;
  section?: string;
  testIdSuffix: string;
  employees: ContractTableController["employees"];
  children?: ReactNode;
}

/**
 * 分期 9 个动作 Modal 的共用骨架：Modal + InlineError + FieldConfigScope + BusinessRegistrationForm
 * 的布局属性完全一致，差异（标题/字段/文案/权限/危险态/testIdSuffix）通过 props 与 children 表达。
 */
function InstallmentActionModal({
  title,
  open,
  onCancel,
  scope,
  form,
  onFinish,
  write,
  permission,
  submitLabel,
  danger,
  intro,
  outro,
  section,
  testIdSuffix,
  employees,
  children,
}: InstallmentActionModalProps) {
  return (
    <Modal title={title} open={open} onCancel={onCancel} footer={null}>
      <InlineError error={write.error} />
      <FieldConfigScope scope={scope} active={open}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
          scope={scope}
          form={form}
          onFinish={onFinish}
        >
          {intro}
          {children}
          <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
          <CustomFieldSection {...(section ? { section } : {})} testIdSuffix={testIdSuffix} />
          {outro}
          <PermissionButton
            permission={permission}
            type="primary"
            danger={danger}
            htmlType="submit"
            loading={write.pending}
          >
            {submitLabel}
          </PermissionButton>
        </BusinessRegistrationForm>
      </FieldConfigScope>
    </Modal>
  );
}

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

export function RecoverModal({ controller }: { controller: ContractTableController }) {
  const { employees, recoverForm, recoverTarget, setRecoverTarget, submitRecover, write } = controller;
  return (
    <InstallmentActionModal
      title={recoverTarget ? `逾期回收 · ${recoverTarget.inst_no}` : "逾期回收"}
      open={Boolean(recoverTarget)}
      onCancel={() => setRecoverTarget(null)}
      scope="INSTRECOVER"
      form={recoverForm}
      onFinish={submitRecover}
      write={write}
      permission="order.update"
      submitLabel="确认回收"
      employees={employees}
      testIdSuffix="installment-recover"
    >
      <CfgItem
        name="occurred_on"
        label="回收日期"
        rules={[{ required: true }]}
        getValueFromEvent={dateValueFromEvent}
        getValueProps={dateValueProps}
      >
        <DateField />
      </CfgItem>
      <CfgItem name="note" label="回收说明" rules={[{ required: true }]}>
        <Input.TextArea rows={2} />
      </CfgItem>
    </InstallmentActionModal>
  );
}

export function ResaleModal({ controller }: { controller: ContractTableController }) {
  const { employees, resaleOrders, resaleForm, resaleTarget, setResaleTarget, submitResale, write } = controller;
  return (
    <InstallmentActionModal
      title={resaleTarget ? `登记出售 · ${resaleTarget.inst_no}` : "登记出售"}
      open={Boolean(resaleTarget)}
      onCancel={() => setResaleTarget(null)}
      scope="INSTRESALE"
      form={resaleForm}
      onFinish={submitResale}
      write={write}
      permission="order.update"
      submitLabel="确认登记"
      employees={employees}
      intro={
        <Typography.Paragraph type="secondary">
          回收账号转售登记：请先在库存中心售出该账号生成售出订单，再在此关联。
          出售订单必须已登记 SELL 事件且关联同一账号，每个合约只能登记一次。
        </Typography.Paragraph>
      }
      testIdSuffix="installment-resale"
    >
      <CfgItem
        name="resale_order_id"
        label="出售订单"
        rules={[{ required: true, message: "请选择出售订单" }]}
      >
        <Select
          showSearch
          placeholder="请选择售出订单"
          optionFilterProp="label"
          options={resaleOrders
            .filter((item) => item.id !== resaleTarget?.order_id)
            .map((item) => ({
              value: item.id,
              label: `${item.order_no}${item.party_name ? ` · ${item.party_name}` : ""}`,
            }))}
        />
      </CfgItem>
      <CfgItem
        name="occurred_on"
        label="出售日期"
        rules={[{ required: true }]}
        getValueFromEvent={dateValueFromEvent}
        getValueProps={dateValueProps}
      >
        <DateField />
      </CfgItem>
      <CfgItem name="note" label="出售说明" rules={[{ required: true }]}>
        <Input.TextArea rows={2} />
      </CfgItem>
    </InstallmentActionModal>
  );
}

export function DeliverModal({ controller }: { controller: ContractTableController }) {
  const { deliverForm, deliverTarget, employees, setDeliverTarget, submitDeliver, write } = controller;
  return (
    <InstallmentActionModal
      title={deliverTarget ? `换绑交付 · ${deliverTarget.inst_no}` : "换绑交付"}
      open={Boolean(deliverTarget)}
      onCancel={() => setDeliverTarget(null)}
      scope="INSTDELIVER"
      form={deliverForm}
      onFinish={submitDeliver}
      write={write}
      permission="order.event.post"
      submitLabel="确认交付"
      employees={employees}
      testIdSuffix="installment-deliver-extra"
      outro={
        <Typography.Paragraph type="secondary">
          仅已结清合约可交付；DELIVER 无金额、不生成现金流，不再确认收入。
        </Typography.Paragraph>
      }
    >
      <CfgItem name="delivery_mode" label="交付方式" rules={[{ required: true }]}>
        <Select />
      </CfgItem>
      <CfgItem name="bound_phone" label="换绑手机号">
        <Input placeholder="可选填，默认带出建单信息" />
      </CfgItem>
      <CfgItem name="bound_phone_owner" label="手机号绑定人">
        <Input placeholder="可选填，默认带出建单信息" />
      </CfgItem>
      <CfgItem
        name="delivered_on"
        label="换绑日期"
        rules={[{ required: true }]}
        getValueFromEvent={dateValueFromEvent}
        getValueProps={dateValueProps}
      >
        <DateField />
      </CfgItem>
      <CfgItem name="note" label="换绑凭证" rules={[{ required: true }]}>
        <Input.TextArea rows={2} />
      </CfgItem>
      <CustomFieldSection section="DELIVER" testIdSuffix="installment-deliver" />
    </InstallmentActionModal>
  );
}

export function CancelModal({ controller }: { controller: ContractTableController }) {
  const { cancelForm, cancelTarget, employees, setCancelTarget, submitCancel, write } = controller;
  return (
    <InstallmentActionModal
      title={cancelTarget ? `退款登记 · ${cancelTarget.inst_no}` : "退款登记"}
      open={Boolean(cancelTarget)}
      onCancel={() => setCancelTarget(null)}
      scope="INSTCANCEL"
      form={cancelForm}
      onFinish={submitCancel}
      write={write}
      permission="order.event.post"
      danger
      submitLabel="确认退款并终止分期"
      employees={employees}
      intro={
        <Typography.Paragraph type="secondary">
          {cancelTarget?.contract_type === "PICKUP_SALE"
            ? "按已收款原资金账户退款，提号取消后账号直接结束。"
            : "按已收款原资金账户退款，取消后账号回到库存。"}
        </Typography.Paragraph>
      }
      testIdSuffix="installment-cancel"
    >
      <CfgItem
        name="cancelled_on"
        label="取消日期"
        rules={[{ required: true }]}
        getValueFromEvent={dateValueFromEvent}
        getValueProps={dateValueProps}
      >
        <DateField />
      </CfgItem>
      <CfgItem name="reason" label="取消原因" rules={[{ required: true }]}>
        <Input.TextArea rows={3} placeholder="请输入退款及取消原因" />
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

export function DefaultModal({ controller }: { controller: ContractTableController }) {
  const { defaultForm, defaultTarget, employees, setDefaultTarget, submitDefault, write } = controller;
  return (
    <InstallmentActionModal
      title={defaultTarget ? `登记违约 · ${defaultTarget.inst_no}` : "登记违约"}
      open={Boolean(defaultTarget)}
      onCancel={() => setDefaultTarget(null)}
      scope="INSTDEFAULT"
      form={defaultForm}
      onFinish={submitDefault}
      write={write}
      permission="order.update"
      danger
      submitLabel="确认登记违约"
      employees={employees}
      intro={
        <Typography.Paragraph type="secondary">
          登记后合约进入 DEFAULTED，仅可继续收款或关闭，不可再交付。
        </Typography.Paragraph>
      }
      testIdSuffix="installment-default"
    >
      <CfgItem name="reason" label="违约原因" rules={[{ required: true, message: "请填写违约原因" }]}>
        <Input.TextArea rows={3} />
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

export function ContractModals({ controller }: { controller: ContractTableController }) {
  return (
    <>
      <PayModal controller={controller} />
      <RecoverModal controller={controller} />
      <ResaleModal controller={controller} />
      <DeliverModal controller={controller} />
      <CancelModal controller={controller} />
      <SettleModal controller={controller} />
      <DefaultModal controller={controller} />
      <WaiveModal controller={controller} />
      <ExtendModal controller={controller} />
    </>
  );
}
