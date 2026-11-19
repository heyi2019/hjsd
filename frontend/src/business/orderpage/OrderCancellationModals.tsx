import { Input, Typography } from "antd";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../ConfigurableField";
import { DateField, MoneyInput, Select, BusinessActionModal, BusinessRegistrationForm, dateValueFromEvent, dateValueProps } from "../../shared/ui";
import { ResponsibleEmployeeSelect } from "../ResponsibleEmployeeSelect";
import { executionActionLabel, money, today } from "../../shared/lib/format";
import { cancelRefundIntro } from "../../shared/lib/cancellationCopy";
import { requiredMoneyRules } from "../../shared/lib/validators";
import { InventoryCancellationDialog } from "../stocks/InventoryCancellationDialog";
import { type OrdersPageController } from "./useOrdersPageController";

export function SharedCancellationDialog({ controller }: { controller: OrdersPageController }) {
  const {
    cancelForm,
    cancelOrderTarget,
    cancelPools,
    cancelScope,
    cancelSubmitting,
    closeCancelTransaction,
    hasSharedCancellation,
    sharedCancellationEvent,
    submitCancelTransaction,
  } = controller;
  return (
    <InventoryCancellationDialog
      open={hasSharedCancellation}
      title={cancelOrderTarget ? `取消 · ${cancelOrderTarget.order_no}` : "取消"}
      amount={sharedCancellationEvent?.remaining ?? "0.00"}
      pools={cancelPools}
      form={cancelForm}
      scope={cancelScope}
      submitting={cancelSubmitting}
      okText="确认取消"
      amountLabel={cancelScope === "INVREFUND" ? "退回金额" : "退款金额"}
      accountLabel={cancelScope === "INVREFUND" ? "收款账户" : "付款账户"}
      onCancel={closeCancelTransaction}
      onFinish={(values) => void submitCancelTransaction({ ...values, cancelled_on: today() })}
      description={cancelScope === "INVREFUND"
        ? <p className="muted">将冲销来源订单的买入流水（¥{money(sharedCancellationEvent?.remaining ?? "0.00")}），退回金额进入所选收款账户；订单状态变为「取消」并退出在库统计。取消不可撤销，历史轨迹保留。</p>
        : <p className="muted">将冲销来源订单的售出流水（¥{money(sharedCancellationEvent?.remaining ?? "0.00")}），退款金额将从所选付款账户支出；订单状态变为「取消」，历史轨迹保留。</p>}
    />
  );
}

export function CancelTransactionModal({ controller }: { controller: OrdersPageController }) {
  const {
    cancelEmployees,
    cancelForm,
    cancelInstallmentTarget,
    cancelOrderTarget,
    cancelPools,
    cancelScope,
    cancelSubmitting,
    cancelableEventsForScope,
    closeCancelTransaction,
    hasSharedCancellation,
    submitCancelTransaction,
  } = controller;
  return (
      <BusinessActionModal
        title={cancelInstallmentTarget ? `取消 · ${cancelInstallmentTarget.inst_no}` : cancelOrderTarget ? `取消 · ${cancelOrderTarget.order_no}` : "取消"}
        fieldCount={6}
        open={Boolean(cancelInstallmentTarget || (cancelOrderTarget && !hasSharedCancellation))}
        confirmLoading={cancelSubmitting}
        onCancel={closeCancelTransaction}
        okText="确认取消"
        okButtonProps={{ danger: true }}
        onOk={() => void cancelForm.submit()}
      >
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope={cancelInstallmentTarget ? "INVCANCEL" : cancelScope} form={cancelForm} onFinish={submitCancelTransaction}>
          <FieldConfigScope scope={cancelInstallmentTarget ? "INVCANCEL" : cancelScope} active={Boolean(cancelOrderTarget || cancelInstallmentTarget)}>
          <Typography.Paragraph type="secondary">
            {cancelInstallmentTarget
              ? cancelRefundIntro(cancelInstallmentTarget.contract_type)
              : cancelScope === "INVREFUND"
                ? "冲销入库流水，金额进入公司钱包；可按原资金账户入账，也可做部分冲销。"
                : "冲销售出流水，金额退还客户；可按原资金账户退款，也可做部分冲销。"}
          </Typography.Paragraph>
          {cancelOrderTarget && cancelableEventsForScope(cancelOrderTarget, cancelScope).length > 0 ? (
            <div className="order-cancel-meta">
              <CfgItem
                name="offset_event_id"
                label={cancelScope === "INVREFUND" ? "入库流水" : "售出流水"}
                fixedLabel={cancelScope === "INVREFUND" ? "入库流水" : "售出流水"}
                rules={[{ required: true, message: cancelScope === "INVREFUND" ? "请选择入库流水" : "请选择售出流水" }]}
              >
                <Select
                  placeholder={cancelScope === "INVREFUND" ? "请选择入库流水" : "请选择被冲销动作"}
                  options={cancelableEventsForScope(cancelOrderTarget, cancelScope).map(({ event, remaining }) => ({
                    value: event.id,
                    label: `${executionActionLabel(event.event_type, cancelOrderTarget.order_type)} · ${event.event_no} · ¥${money(event.amount)}（剩余可冲 ¥${money(remaining)}）`,
                  }))}
                  onChange={(value: number) => {
                    const target = cancelableEventsForScope(cancelOrderTarget, cancelScope).find((item) => item.event.id === value);
                    if (target) cancelForm.setFieldsValue({
                      [cancelScope === "INVREFUND" ? "refund_amount" : "cancel_amount"]: target.remaining,
                      pool_id: target.event.pool_id ?? cancelPools[0]?.id,
                      // 切换冲销流水后操作人不沿用上一笔：清空交给写路径按当前会话兜底解析（#19）。
                      operator_user_ids: undefined,
                    });
                  }}
                />
              </CfgItem>
              <CfgItem name={cancelScope === "INVREFUND" ? "refund_amount" : "cancel_amount"} label={cancelScope === "INVREFUND" ? "入账金额" : "退款金额"} rules={requiredMoneyRules(cancelScope === "INVREFUND" ? "入账金额" : "退款金额")} tooltip="留空或填剩余可冲金额为全额冲销；小于剩余金额即为部分冲销">
                <MoneyInput aria-label={cancelScope === "INVREFUND" ? "入账金额" : "退款金额"} placeholder={cancelScope === "INVREFUND" ? "请输入入账金额" : "请输入退款金额"} />
              </CfgItem>
              <CfgItem alwaysActive name="pool_id" label={cancelScope === "INVREFUND" ? "入账账户" : "收款账户"} rules={[{ required: true, message: cancelScope === "INVREFUND" ? "请选择入账账户" : "请选择收款账户" }]}>
                <Select placeholder={cancelScope === "INVREFUND" ? "请选择入账账户" : "请选择收款账户"} options={cancelPools.map((pool) => ({ value: pool.id, label: pool.name }))} notFoundContent="暂无可用资金账户" />
              </CfgItem>
              <ResponsibleEmployeeSelect name="operator_user_ids" label={cancelScope === "INVREFUND" ? "入账操作人" : "退款操作人"} employees={cancelEmployees} className="order-cancel-employee" />
            </div>
          ) : null}
          <CfgItem name="cancelled_on" label="取消日期" rules={[{ required: true, message: "请输入取消日期" }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
            <DateField />
          </CfgItem>
          <CfgItem name="reason" label="取消原因" rules={[{ required: true, message: "请输入取消原因" }]}>
            <Input.TextArea rows={3} placeholder="请输入退款及取消原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix="order-cancel" />
          </FieldConfigScope>
        </BusinessRegistrationForm>
      </BusinessActionModal>
  );
}
