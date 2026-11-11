import dayjs, { type Dayjs } from "dayjs";
import { DatePicker, Form, Input, Typography } from "antd";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../ConfigurableField";
import { MoneyInput, MoneyText, Select, BusinessActionModal, BusinessRegistrationForm, dateValueFromEvent, dateValueProps } from "../../shared/ui";
import { ResponsibleEmployeeSelect } from "../ResponsibleEmployeeSelect";
import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { today } from "../../shared/lib/format";
import { cashflowsApi } from "../../shared/api/catalog";
import { requiredMoneyRules } from "../../shared/lib/validators";
import { type OrdersPageController } from "./useOrdersPageController";

/**
 * 分润是实际业务动作：登记后写入 PROFIT_SHARE 事件，并由后端生成一笔支出资金明细。
 * 「分润配置」弹窗仍保留给收益分配规则；这里单独登记实际发生的分润动作。
 */
export function ProfitShareModal({ controller }: { controller: OrdersPageController }) {
  const {
    actionOrder,
    profitShareForm,
    profitShareOpen,
    profitSharePools,
    profitShareSubmitting,
    setActionOrder,
    setProfitShareOpen,
    submitProfitShare,
    users,
  } = controller;
  return (
    <BusinessActionModal
      title={actionOrder ? `登记分润 · ${actionOrder.order_no}` : "登记分润"}
      fieldCount={6}
      open={profitShareOpen}
      confirmLoading={profitShareSubmitting}
      onCancel={() => { setProfitShareOpen(false); setActionOrder(null); }}
      onOk={() => void profitShareForm.submit()}
    >
      <BusinessRegistrationForm
        layout="horizontal"
        labelAlign="left"
        labelCol={{ flex: "108px" }}
        wrapperCol={{ flex: "auto" }}
        scope="ALLOCATION"
        form={profitShareForm}
        onFinish={(values: {
          profit_recipient: "BUY" | "SELL" | "OPERATION" | "COMPANY";
          amount: string;
          occurred_on: Dayjs;
          pool_id: number;
          operator_user_ids?: number[];
          note?: string;
        }) => void submitProfitShare(values)}
      >
        <CfgItem
          name="profit_recipient"
          label="分润归属"
          initialValue="COMPANY"
          rules={[{ required: true, message: "请选择分润归属" }]}
        >
          <Select
            options={[
              { value: "BUY", label: "买号" },
              { value: "SELL", label: "售出" },
              { value: "OPERATION", label: "运营" },
              { value: "COMPANY", label: "公司" },
            ]}
          />
        </CfgItem>
        <CfgItem name="amount" label="分润金额" rules={requiredMoneyRules("分润金额")}>
          <MoneyInput aria-label="分润金额" placeholder="请输入分润金额" />
        </CfgItem>
        <CfgItem
          name="occurred_on"
          label="发生日期"
          rules={[{ required: true, message: "请选择发生日期" }]}
          getValueFromEvent={dateValueFromEvent}
          getValueProps={dateValueProps}
        >
          <DatePicker format="YYYY-MM-DD" className="ui-control-full" />
        </CfgItem>
        <CfgItem name="pool_id" label="支出账户" rules={[{ required: true, message: "请选择支出账户" }]}>
          <Select
            aria-label="支出账户"
            placeholder="请选择分润支出的资金账户"
            options={profitSharePools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))}
            notFoundContent="暂无可用资金账户"
          />
        </CfgItem>
        <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={users} />
        <CfgItem name="note" label="备注">
          <Input.TextArea rows={3} placeholder="请输入分润备注（选填）" />
        </CfgItem>
      </BusinessRegistrationForm>
      <Typography.Paragraph type="secondary" className="ui-form-spaced">
        分润会生成一笔「支出」资金明细，归属只记录业务属性，不改变资金流向。
      </Typography.Paragraph>
    </BusinessActionModal>
  );
}

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
