/** 资金中心各弹窗（Modal）视图层：新增押金/流水/划转/对账，以及冲销、释放、损失、取消、修复、核销。
 *  全部通过 controller 消费 useFundsPageController 暴露的表单、目标状态与写处理器。
 *  9 个表单弹窗共用 FundsActionModal 骨架。 */
import { Form, Input, Typography } from "antd";
import type { FormInstance } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { ReactNode } from "react";
import { BusinessActionModal, BusinessRegistrationForm, DataTable, DateField, InlineError, MoneyInput, MoneyText, PermissionButton, Select, StatusTag, dateValueFromEvent, dateValueProps } from "../shared/ui";
import type { NormalizedError } from "../shared/api/client";
import type { Permission } from "../shared/state/session";
import type { EmployeeOption } from "../shared/api/types/org";
import { CfgItem, CustomFieldSections, FieldConfigScope } from "../business/ConfigurableField";
import { today } from "../shared/lib/format";
import { positiveIntegerRules, requiredMoneyRules } from "../shared/lib/validators";
import { configurableLabel } from "../shared/lib/optionSets";
import { ACCOUNTING_ATTRIBUTE_LABEL } from "../shared/lib/labels";
import type { FundsPageController } from "./useFundsPageController";
import { ResponsibleEmployeeSelect } from "../business/ResponsibleEmployeeSelect";

const Modal = BusinessActionModal;

type WriteState = { error: NormalizedError | null; pending: boolean };
type Pool = FundsPageController["pools"][number];

/** 资金账户下拉选项只展示名称；编号仍由后端按选中 id 绑定。 */
function poolOptions(pools: Pool[], opts?: { excludeId?: number; withTitle?: boolean }) {
  return pools
    .filter((pool) => pool.id !== opts?.excludeId)
    .map((pool) => {
      const label = pool.name;
      return opts?.withTitle ? { value: pool.id, title: label, label } : { value: pool.id, label };
    });
}
interface FundsActionModalProps {
  title: string;
  fieldCount: number;
  wrapClassName?: string;
  open: boolean;
  onCancel: () => void;
  scope: string;
  form: FormInstance;
  onFinish: (values: Record<string, unknown>) => void;
  initialValues?: Record<string, unknown>;
  write: WriteState;
  permission: Permission;
  submitLabel: string;
  danger?: boolean;
  /** 错误提示之前的信息（修复单边划转的划转号）。 */
  beforeError?: ReactNode;
  /** 错误提示之后、表单之前的说明（押金释放/损失/取消的风险提示）。 */
  intro?: ReactNode;
  /** 表单内部的说明（冲销规则），位于字段之前。 */
  formIntro?: ReactNode;
  children: ReactNode;
  employees?: EmployeeOption[];
  showOperator?: boolean;
}

/**
 * 资金中心 10 个表单弹窗的共用骨架：BusinessActionModal + InlineError + FieldConfigScope +
 * BusinessRegistrationForm 的布局属性完全一致，差异（标题/字段数/字段/文案/权限/危险态/初始值）
 * 通过 props 与 children 表达，并展示当前作用域配置的自定义字段。
 */
function FundsActionModal({
  title,
  fieldCount,
  wrapClassName,
  open,
  onCancel,
  scope,
  form,
  onFinish,
  initialValues,
  write,
  permission,
  submitLabel,
  danger,
  beforeError,
  intro,
  formIntro,
  children,
  employees = [],
  showOperator = false,
}: FundsActionModalProps) {
  return (
    <Modal title={title} fieldCount={fieldCount} wrapClassName={wrapClassName} open={open} onCancel={onCancel} footer={null}>
      {beforeError}
      <InlineError error={write.error} />
      {intro}
      <FieldConfigScope scope={scope} active={open}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
          scope={scope}
          form={form}
          onFinish={onFinish}
          initialValues={initialValues}
        >
          {formIntro}
          {children}
          <CustomFieldSections testIdSuffix={scope.toLowerCase()} />
          {showOperator ? <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} /> : null}
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
export function DepositModal({ ctrl }: { ctrl: FundsPageController }) {
  const { depositOpen, depositEditTarget, closeDeposit, depositForm, submitDeposit, write, pools, employees } = ctrl;
  return (
    <FundsActionModal
      title={depositEditTarget ? "编辑押金占用" : "新增押金占用"} fieldCount={9} wrapClassName="deposit-modal"
      open={depositOpen} onCancel={closeDeposit}
      scope="FUNDDEPOSIT" form={depositForm} onFinish={submitDeposit}
      initialValues={{ paid_on: today(), ledger_type: "BUSINESS" }}
      write={write} permission="deposit.post" submitLabel={depositEditTarget ? "保存修改" : "提交"}
      employees={employees} showOperator
    >
      <CfgItem name="pool_id" label="资金账户" rules={[{ required: true }]}>
        <Select aria-label="资金账户" options={poolOptions(pools)} />
      </CfgItem>
      <Form.Item name="ledger_type" label="押金性质" rules={[{ required: true }]}>
        <Select aria-label="押金性质" options={[
          { value: "BUSINESS", label: "业务押金" },
          { value: "STUDIO", label: "工作室运营押金" },
        ]} />
      </Form.Item>
      <CfgItem name="amount" label="占用金额" rules={requiredMoneyRules("占用金额")}>
        <MoneyInput />
      </CfgItem>
      <CfgItem name="counterparty_id" label="合作方编号" rules={positiveIntegerRules("合作方编号")} extra="可选，填写已建档合作方编号">
        <Input inputMode="numeric" />
      </CfgItem>
      <CfgItem name="source_order_id" label="来源订单编号" rules={positiveIntegerRules("来源订单编号")} extra="可选，填写关联订单编号">
        <Input inputMode="numeric" />
      </CfgItem>
      <CfgItem name="paid_on" label="占用日期" rules={[{ required: true }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
        <DateField />
      </CfgItem>
      <CfgItem name="expected_release_on" label="预计释放日期" getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
        <DateField />
      </CfgItem>
      <CfgItem name="note" label="说明" className="deposit-modal__note">
        <Input.TextArea rows={2} />
      </CfgItem>
    </FundsActionModal>
  );
}
export function TransferModal({ ctrl }: { ctrl: FundsPageController }) {
  const { transferOpen, setTransferOpen, transferForm, submitTransfer, write, pools, employees } = ctrl;
  return (
    <FundsActionModal
      title="资金账户划转" fieldCount={6}
      open={transferOpen} onCancel={() => { setTransferOpen(false); transferForm.resetFields(); }}
      scope="FUNDTRANSFER" form={transferForm} onFinish={submitTransfer}
      initialValues={{ occurred_on: today() }}
      write={write} permission="finance.transfer" submitLabel="确认划转" employees={employees} showOperator
    >
      <CfgItem name="source_pool_id" label="转出资金账户" rules={[{ required: true }]}><Select options={poolOptions(pools)} /></CfgItem>
      <CfgItem name="target_pool_id" label="转入资金账户" rules={[{ required: true }]}><Select options={poolOptions(pools)} /></CfgItem>
      <CfgItem name="amount" label="划转金额" rules={requiredMoneyRules("划转金额")}><MoneyInput /></CfgItem>
      <CfgItem name="occurred_on" label="划转日期" rules={[{ required: true }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}><DateField /></CfgItem>
      <CfgItem name="note" label="说明"><Input.TextArea rows={2} /></CfgItem>
    </FundsActionModal>
  );
}

export function ReconciliationModal({ ctrl }: { ctrl: FundsPageController }) {
  const { reconciliationOpen, setReconciliationOpen, reconciliationForm, submitReconciliation, write, pools, employees } = ctrl;
  return (
    <FundsActionModal
      title="新增资金对账" fieldCount={8}
      open={reconciliationOpen} onCancel={() => { setReconciliationOpen(false); reconciliationForm.resetFields(); }}
      scope="FUNDRECON" form={reconciliationForm} onFinish={submitReconciliation}
      initialValues={{ reconciled_on: today() }}
      write={write} permission="deposit.post" submitLabel="提交对账" employees={employees} showOperator
    >
      <CfgItem name="pool_id" label="资金账户" rules={[{ required: true }]}><Select aria-label="资金账户" options={poolOptions(pools)} /></CfgItem>
      <CfgItem name="reconciled_on" label="对账日期" rules={[{ required: true }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}><DateField /></CfgItem>
      <CfgItem name="account_label" label="对账账户" rules={[{ required: true }]} extra="同一资金账户 + 对账账户 + 对账日期只能对账一次，重复提交会被拒绝"><Input /></CfgItem>
      <CfgItem name="statement_balance" label="账面余额" rules={requiredMoneyRules("账面余额")}><MoneyInput /></CfgItem>
      <CfgItem name="reason" label="差异原因" extra="账面余额与系统余额不一致时必填（系统余额=期初余额+已入账流水）"><Input.TextArea rows={2} /></CfgItem>
      <CfgItem name="note" label="说明"><Input.TextArea rows={2} /></CfgItem>
    </FundsActionModal>
  );
}

export function ResolveModal({ ctrl }: { ctrl: FundsPageController }) {
  const { resolveTarget, setResolveTarget, resolveForm, resolveReconciliation, write, employees } = ctrl;
  return (
    <FundsActionModal
      title="核销对账差异" fieldCount={2}
      open={Boolean(resolveTarget)} onCancel={() => { setResolveTarget(null); resolveForm.resetFields(); }}
      scope="FUNDCLEAR" form={resolveForm} onFinish={resolveReconciliation}
      write={write} permission="deposit.post" submitLabel="确认核销" employees={employees} showOperator
    >
      <CfgItem name="reason" label="处理说明" rules={[{ required: true }]}><Input.TextArea rows={3} /></CfgItem>
    </FundsActionModal>
  );
}

export function ReleaseModal({ ctrl }: { ctrl: FundsPageController }) {
  const { returnTarget, setReturnTarget, returnForm, submitReturn, write, employees } = ctrl;
  return (
    <FundsActionModal
      title="押金释放" fieldCount={3}
      open={Boolean(returnTarget)} onCancel={() => { setReturnTarget(null); returnForm.resetFields(); }}
      scope="FUNDRELEASE" form={returnForm} onFinish={submitReturn}
      write={write} permission="deposit.post" submitLabel="确认释放"
      employees={employees} showOperator
      intro={
        <>
          {returnTarget ? (
            <Typography.Paragraph type="secondary">
              押金占用合计 <MoneyText value={returnTarget.paid_amount} />；已释放 <MoneyText value={returnTarget.returned_amount} />；已损失 <MoneyText value={returnTarget.lost_amount ?? "0.00"} />；剩余可释放 <MoneyText value={returnTarget.remaining_amount} strong />。
            </Typography.Paragraph>
          ) : null}
          <Typography.Paragraph type="warning">
            释放后相应减少押金占用，操作不可撤销；释放金额不得超过剩余可释放额。
          </Typography.Paragraph>
        </>
      }
    >
      <CfgItem
        name="amount"
        label="释放金额"
        rules={[
          ...requiredMoneyRules("释放金额"),
          () => ({
            validator(_rule: unknown, value: unknown) {
              if (!returnTarget || !value) return Promise.resolve();
              // 上限取后端下发的剩余可释放额（口径同押金「剩余」列），不在前端重算。
              const max = Number(returnTarget.remaining_amount);
              if (Number(value) > max + 1e-9) {
                return Promise.reject(new Error(`释放金额不得超过剩余可释放额 ¥${returnTarget.remaining_amount}`));
              }
              return Promise.resolve();
            },
          }),
        ]}
      >
        <MoneyInput />
      </CfgItem>
      <CfgItem name="released_on" label="释放日期" rules={[{ required: true }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
        <DateField />
      </CfgItem>
    </FundsActionModal>
  );
}

export function LossModal({ ctrl }: { ctrl: FundsPageController }) {
  const { lossTarget, setLossTarget, lossForm, submitLoss, write, employees } = ctrl;
  return (
    <FundsActionModal
      title="登记押金损失" fieldCount={5}
      open={Boolean(lossTarget)} onCancel={() => { setLossTarget(null); lossForm.resetFields(); }}
      scope="FUNDLOSS" form={lossForm} onFinish={submitLoss}
      write={write} permission="deposit.post" submitLabel="确认损失"
      employees={employees} showOperator
      intro={
        <Typography.Paragraph type="warning">
          登记损失后该押金占用相应扣减，操作不可撤销，请核对金额与费用分类。
        </Typography.Paragraph>
      }
    >
      <CfgItem name="amount" label="损失金额" rules={requiredMoneyRules("损失金额")}><MoneyInput /></CfgItem>
      <CfgItem name="lost_on" label="损失日期" rules={[{ required: true }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}><DateField /></CfgItem>
      <CfgItem name="category" label="费用分类" rules={[{ required: true }]}><Input /></CfgItem>
      <CfgItem name="reason" label="损失原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></CfgItem>
    </FundsActionModal>
  );
}

export function CancelModal({ ctrl }: { ctrl: FundsPageController }) {
  const { cancelTarget, setCancelTarget, cancelForm, submitCancelDeposit, write, employees } = ctrl;
  return (
    <FundsActionModal
      title="取消押金" fieldCount={3}
      open={Boolean(cancelTarget)} onCancel={() => { setCancelTarget(null); cancelForm.resetFields(); }}
      scope="FUNDCANCEL" form={cancelForm} onFinish={submitCancelDeposit}
      write={write} permission="deposit.post" submitLabel="确认取消" danger
      employees={employees} showOperator
      intro={
        <>
          {cancelTarget ? (
            <Typography.Paragraph type="secondary">
              押金占用合计 <MoneyText value={cancelTarget.paid_amount} />，尚未发生任何退还或损失。
            </Typography.Paragraph>
          ) : null}
          <Typography.Paragraph type="warning">
            取消用于「押金登记有误 / 租约取消且押金从未实际占用」。系统会按占用全额自动写一笔
            DEPOSIT_CANCEL 冲正流水把资金账户占用冲平，操作不可撤销；已发生退还或损失的押金请改用释放 / 登记损失。
          </Typography.Paragraph>
        </>
      }
    >
      <CfgItem name="cancelled_on" label="取消日期" rules={[{ required: true }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
        <DateField />
      </CfgItem>
      <CfgItem name="reason" label="取消原因" rules={[{ required: true, message: "请填写取消原因" }]}>
        <Input.TextArea rows={3} />
      </CfgItem>
    </FundsActionModal>
  );
}
