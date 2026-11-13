import dayjs, { type Dayjs } from "dayjs";
import { DatePicker, Form, Input, Typography } from "antd";
import { useEffect, useState } from "react";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../../orders/ConfigurableField";
import { ResponsibleEmployeeSelect } from "../../orders/ResponsibleEmployeeSelect";
import { normalizeError } from "../../shared/api/client";
import { today } from "../../shared/lib/format";
import { requiredMoneyRules } from "../../shared/lib/validators";
import { BusinessActionModal, BusinessRegistrationForm, ErrorBanner, MoneyInput, MoneyText, Select as UiSelect, dateValueFromEvent, dateValueProps } from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";
import { createOrderCashflow } from "./cashflow-service";
import type { CashflowFormValues, CashflowModalProps } from "./types";

export function CashflowModal({
  target,
  pools,
  users = [],
  scope = "FUNDFLOW",
  showOperator = false,
  showDetails = false,
  currentOperator,
  onClose,
  onCreated,
}: CashflowModalProps) {
  const [form] = Form.useForm<CashflowFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const open = Boolean(target);

  useEffect(() => {
    if (!target) return;
    form.resetFields();
    form.setFieldsValue({
      occurred_on: dayjs(today()),
      direction: "OUT",
      pool_id: pools[0]?.id,
    });
    setError(null);
  }, [form, pools, target]);

  const submit = async (values: CashflowFormValues) => {
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      await createOrderCashflow(target.orderId, values);
      appMessage.success("资金收支已登记");
      form.resetFields();
      onClose();
      await onCreated();
    } catch (cause) {
      const normalized = normalizeError(cause);
      setError(normalized);
      appMessage.error(normalized.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BusinessActionModal
      title={target ? `资金收支 · ${target.orderNo}` : "资金收支"}
      fieldCount={showDetails ? 6 : showOperator ? 6 : 5}
      open={open}
      confirmLoading={submitting}
      okText="确定"
      onCancel={onClose}
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
          <CfgItem name="occurred_on" label="发生日期" rules={[{ required: true, message: "请选择发生日期" }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
            <DatePicker format="YYYY-MM-DD" className="ui-control-full" />
          </CfgItem>
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
              options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))}
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
