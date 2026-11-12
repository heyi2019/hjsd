import dayjs, { type Dayjs } from "dayjs";
import { DatePicker, Form, Input, Typography } from "antd";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../ConfigurableField";
import { MoneyInput, MoneyText, Select, BusinessActionModal, BusinessRegistrationForm, dateValueFromEvent, dateValueProps } from "../../shared/ui";
import { ResponsibleEmployeeSelect } from "../ResponsibleEmployeeSelect";
import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { today } from "../../shared/lib/format";
import { cashflowsApi } from "../../shared/api/cashflows.api";
import { requiredMoneyRules } from "../../shared/lib/validators";
import { type OrdersPageController } from "./useOrdersPageController";

export function RefundModal({ controller }: { controller: OrdersPageController }) {
  const {
    actionOrder,
    cancelPools,
    currentOperator,
    load,
    refundForm,
    refundOpen,
    refundSubmitting,
    setActionOrder,
    setRefundOpen,
    setRefundSubmitting,
    users,
  } = controller;
  const direction = Form.useWatch<string>("direction", refundForm) ?? "OUT";
  return (
      <BusinessActionModal
        title={actionOrder ? `资金收支 · ${actionOrder.order_no}` : "资金收支"}
        fieldCount={5}
        open={refundOpen}
        confirmLoading={refundSubmitting}
        onCancel={() => { setRefundOpen(false); setActionOrder(null); }}
        onOk={() => void refundForm.submit()}
      >
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="REFUND"
          form={refundForm}
          onFinish={async (values: { amount: string; occurred_on?: Dayjs; direction?: string; category?: string; pool_id?: number; operator_user_ids?: number[]; reason: string; form_extra?: Record<string, unknown> }) => {
            if (!actionOrder) return;
            setRefundSubmitting(true);
            try {
              // 退款已并入普通支出：收入/支出统一走订单资金明细接口，不创建业务事件。
              const flowDirection = values.direction === "IN" ? "IN" : "OUT";
              const flowCategory = values.category || "OTHER";
              await cashflowsApi.createForOrder(actionOrder.id, {
                pool_id: values.pool_id,
                occurred_on: (values.occurred_on ?? dayjs(today())).format("YYYY-MM-DD"),
                direction: flowDirection,
                nature: flowDirection === "IN" ? "BUSINESS_IN" : "BUSINESS_OUT",
                fund_nature: "BUSINESS",
                accounting_attribute: flowDirection === "IN" ? "SELF_REVENUE" : "OPERATING_EXPENSE",
                category: flowCategory,
                amount: values.amount,
                note: values.reason,
                form_extra: values.form_extra,
              });
              appMessage.success("资金收支已登记");
              setRefundOpen(false);
              setActionOrder(null);
              await load();
            } catch (error) {
              appMessage.error(normalizeError(error).message);
            } finally {
              setRefundSubmitting(false);
            }
          }}
        >
          <FieldConfigScope scope="REFUND" active={refundOpen}>
          <CfgItem name="occurred_on" label="发生日期" initialValue={dayjs(today())} rules={[{ required: true, message: "请选择发生日期" }]}>
            <DatePicker format="YYYY-MM-DD" className="ui-control-full" />
          </CfgItem>
          <CfgItem name="direction" label="资金流向" initialValue="OUT" rules={[{ required: true, message: "请选择资金流向" }]}>
            <Select
              aria-label="资金流向"
              options={[{ value: "IN", label: "收入" }, { value: "OUT", label: "支出" }]}
              onChange={(value) => refundForm.setFieldValue("category", "OTHER")}
            />
          </CfgItem>
          <CfgItem name="category" label="资金原因" initialValue="OTHER" rules={[{ required: true, message: "请选择资金原因" }]}>
            <Select
              options={direction === "IN"
                ? [{ value: "SALE", label: "售出/回款" }, { value: "OTHER", label: "其他收入" }]
                : [{ value: "OTHER", label: "其他支出" }]}
            />
          </CfgItem>
          <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={users} />
          <CfgItem name="amount" label="金额" rules={requiredMoneyRules("金额")}>
            <MoneyInput placeholder="请输入退款金额" />
          </CfgItem>
          <CfgItem name="pool_id" label="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}>
            <Select
              aria-label="资金账户"
              placeholder="请选择这笔收支的资金账户"
              options={cancelPools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))}
              notFoundContent="暂无可用资金账户"
            />
          </CfgItem>
          <CfgItem name="reason" label="收支备注" rules={[{ required: true, message: "请输入收支备注" }]}>
            <Input.TextArea rows={3} placeholder="请输入收支备注" />
          </CfgItem>
            <CustomFieldSection testIdSuffix="order-refund" />
          </FieldConfigScope>
        </BusinessRegistrationForm>
        <div className="ui-form-spaced orders-event-list">
          <Typography.Text strong>资金明细</Typography.Text>
          {actionOrder?.cashflows?.length ? (
            <div className="orders-event-table" role="table" aria-label="资金明细表">
              <div className="orders-event-row orders-event-row--header" role="row">
                <span role="columnheader">发生日期</span>
                <span role="columnheader">收支</span>
                <span role="columnheader">金额</span>
                <span role="columnheader">操作人</span>
              </div>
              {actionOrder.cashflows.map((flow) => (
                <div key={flow.flow_no} className="orders-event-row" role="row">
                  <span role="cell">{flow.occurred_on}</span>
                  <span role="cell">{flow.direction === "IN" ? "收入" : "支出"} · {flow.category}</span>
                  <span role="cell"><MoneyText value={flow.amount} /></span>
                  <span role="cell">{flow.operator || currentOperator}</span>
                </div>
              ))}
            </div>
          ) : <Typography.Text type="secondary">暂无资金明细</Typography.Text>}
        </div>
      </BusinessActionModal>
  );
}
