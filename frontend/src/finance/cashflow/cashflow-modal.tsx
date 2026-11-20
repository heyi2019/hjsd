import { Form, Input, Typography } from "antd";
import { useEffect, useState } from "react";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../../business/ConfigurableField";
import { ResponsibleEmployeeSelect } from "../../business/ResponsibleEmployeeSelect";
import { currentDevUser, normalizeError } from "../../shared/api/client";
import { useSession } from "../../shared/state/session";
import { requiredMoneyRules } from "../../shared/lib/validators";
import { BusinessActionModal, BusinessRegistrationForm, ErrorBanner, MoneyInput, MoneyText, Select as UiSelect } from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import { useRequestSession } from "../../shared/hooks/useLatestRequest";
import { createOrderCashflow } from "./cashflow-service";
import type { CashflowFormValues, CashflowModalProps } from "./types";

export function CashflowModal({
  target,
  pools,
  users = [],
  showOperator = false,
  showDetails = false,
  currentOperator,
  onClose,
  onCreated,
}: CashflowModalProps) {
  const scope = "REFUND";
  const [form] = Form.useForm<CashflowFormValues>();
  const write = useAsyncAction();
  const submitting = write.pending;
  // 弹窗会复用表单；关闭或切换目标后，旧请求不能改动新的表单。
  const session = useRequestSession(target);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const open = Boolean(target);
  const { username } = useSession();

  useEffect(() => {
    if (!target) return;
    form.resetFields();
    form.setFieldsValue({
      direction: "OUT",
      pool_id: pools[0]?.id,
    });
    setError(null);
  }, [form, pools, target]);

  useEffect(() => {
    if (!open || !users.length) return;
    const currentValue = form.getFieldValue("operator_user_ids");
    const isEmpty = currentValue == null || (Array.isArray(currentValue) && currentValue.length === 0);
    const devUsername = import.meta.env.DEV ? currentDevUser() : undefined;
    const currentEmployeeId = users.find((employee) => employee.is_active && employee.username === username)?.id
      ?? (devUsername ? users.find((employee) => employee.is_active && employee.username === devUsername)?.id : undefined);
    if (isEmpty && currentEmployeeId !== undefined) form.setFieldValue("operator_user_ids", [currentEmployeeId]);
  }, [form, open, username, users]);

  const submit = async (values: CashflowFormValues) => {
    if (!target) return;
    const submittedTarget = target;
    const submittedSession = session.current();
    await write.run(async () => {
      setError(null);
      try {
        await createOrderCashflow(submittedTarget.orderId, values);
        const isCurrent = session.isCurrent(submittedSession);
        appMessage.success(isCurrent ? "资金收支已登记" : `${submittedTarget.orderNo} 资金收支已登记`);
        if (isCurrent) {
          form.resetFields();
          close();
        }
        void Promise.resolve()
          .then(() => onCreated(submittedTarget))
          .catch(() => appMessage.warning("资金收支已登记，但刷新失败，请手动刷新"));
      } catch (cause) {
        const normalized = normalizeError(cause);
        const isCurrent = session.isCurrent(submittedSession);
        if (isCurrent) setError(normalized);
        appMessage.error(isCurrent ? normalized.message : `${submittedTarget.orderNo}：${normalized.message}`);
      }
    });
  };

  const close = () => {
    session.invalidate();
    onClose();
  };

  return (
    <BusinessActionModal
      title={target ? `资金收支 · ${target.orderNo}` : "资金收支"}
      fieldCount={showDetails ? 5 : showOperator ? 5 : 4}
      open={open}
      confirmLoading={submitting}
      okText="确定"
      onCancel={close}
      onOk={() => void form.submit()}
    >
      <ErrorBanner error={error} />
      <BusinessRegistrationForm
        layout="horizontal"
        labelAlign="left"
        labelCol={{ flex: "108px" }}
        wrapperCol={{ flex: "auto" }}
        scope={scope}
        form={form}
        onFinish={submit}
      >
        <FieldConfigScope scope={scope} active={open}>
          <CfgItem name="direction" label="资金流向" rules={[{ required: true, message: "请选择资金流向" }]}>
            <UiSelect
              aria-label="资金流向"
              options={[{ value: "IN", label: "收入" }, { value: "OUT", label: "支出" }]}
            />
          </CfgItem>
          {showOperator ? <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={users} /> : null}
          <CfgItem name="amount" label="金额" rules={requiredMoneyRules("金额")}>
            <MoneyInput placeholder="请输入资金金额" />
          </CfgItem>
          <CfgItem name="pool_id" label="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}>
            <UiSelect
              aria-label="资金账户"
              placeholder="请选择这笔收支的资金账户"
              options={pools.map((pool) => ({ value: pool.id, label: pool.name }))}
              notFoundContent="暂无可用资金账户"
            />
          </CfgItem>
          <CfgItem name="note" label="收支备注" rules={[{ required: true, message: "请输入收支备注" }]}>
            <Input.TextArea rows={3} placeholder="请输入收支备注" />
          </CfgItem>
          <CustomFieldSection testIdSuffix={`cashflow-${scope.toLowerCase()}`} />
        </FieldConfigScope>
      </BusinessRegistrationForm>
      {showDetails ? (
        <div className="ui-form-spaced orders-event-list">
          <Typography.Text strong>资金明细</Typography.Text>
          {target?.cashflows?.length ? (
            <div className="orders-event-table" role="table" aria-label="资金明细表">
              <div className="orders-event-row orders-event-row--header" role="row">
                <span role="columnheader">发生日期</span>
                <span role="columnheader">收支</span>
                <span role="columnheader">金额</span>
                <span role="columnheader">操作人</span>
              </div>
              {target.cashflows.map((flow) => (
                <div key={flow.flow_no} className="orders-event-row" role="row">
                  <span role="cell">{flow.occurred_on}</span>
                  <span role="cell">{flow.direction === "IN" ? "收入" : "支出"}</span>
                  <span role="cell"><MoneyText value={flow.amount} /></span>
                  <span role="cell">{flow.operator || currentOperator}</span>
                </div>
              ))}
            </div>
          ) : <Typography.Text type="secondary">暂无资金明细</Typography.Text>}
        </div>
      ) : null}
    </BusinessActionModal>
  );
}
