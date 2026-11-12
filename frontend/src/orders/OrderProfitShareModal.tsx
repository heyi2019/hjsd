import dayjs, { type Dayjs } from "dayjs";
import { DatePicker, Form, Input } from "antd";
import { useEffect, useState } from "react";
import type { Pool } from "../shared/api/types/finance";
import type { EmployeeOption } from "../shared/api/types/org";
import { ordersApi } from "../shared/api/orders.api";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { appMessage } from "../shared/ui/appFeedback";
import { BusinessActionModal, BusinessRegistrationForm, MoneyInput, Select } from "../shared/ui";
import { CfgItem, FieldConfigScope } from "./ConfigurableField";
import { ResponsibleEmployeeSelect } from "./ResponsibleEmployeeSelect";
import { requiredMoneyRules } from "../shared/lib/validators";

export type OrderProfitShareTarget = {
  id: number;
  order_no: string;
};

export function OrderProfitShareModal({
  target,
  pools,
  employees,
  onClose,
  onCreated,
}: {
  target: OrderProfitShareTarget | null;
  pools: Pool[];
  employees: EmployeeOption[];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!target) return;
    form.resetFields();
    form.setFieldsValue({
      profit_recipient: "COMPANY",
      occurred_on: dayjs(today()),
      pool_id: pools[0]?.id,
    });
  }, [form, pools, target]);

  const submit = async (values: {
    profit_recipient: "BUY" | "SELL" | "OPERATION" | "COMPANY";
    amount: string;
    occurred_on?: Dayjs;
    pool_id: number;
    operator_user_ids?: number[];
    note?: string;
  }) => {
    if (!target) return;
    setSubmitting(true);
    try {
      await ordersApi.postEvent(target.id, {
        event_type: "PROFIT_SHARE",
        profit_recipient: values.profit_recipient,
        amount: values.amount,
        occurred_on: (values.occurred_on ?? dayjs(today())).format("YYYY-MM-DD"),
        pool_id: Number(values.pool_id),
        operator_user_ids: values.operator_user_ids,
        note: values.note,
      });
      appMessage.success("分润已登记，支出资金明细已生成");
      form.resetFields();
      onClose();
      await onCreated();
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BusinessActionModal
      title={target ? `登记分润 · ${target.order_no}` : "登记分润"}
      fieldCount={6}
      open={Boolean(target)}
      confirmLoading={submitting}
      onCancel={onClose}
      onOk={() => void form.submit()}
    >
      <FieldConfigScope scope="ALLOCATION" active={Boolean(target)}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
          scope="ALLOCATION"
          form={form}
          onFinish={submit}
        >
        <CfgItem name="profit_recipient" label="分润归属" rules={[{ required: true, message: "请选择分润归属" }]}>
          <Select options={[
            { value: "BUY", label: "买号" },
            { value: "SELL", label: "售出" },
            { value: "OPERATION", label: "运营" },
            { value: "COMPANY", label: "公司" },
          ]} />
        </CfgItem>
        <CfgItem name="amount" label="分润金额" rules={requiredMoneyRules("分润金额")}>
          <MoneyInput aria-label="分润金额" placeholder="请输入分润金额" />
        </CfgItem>
        <CfgItem name="occurred_on" label="发生日期" rules={[{ required: true, message: "请选择发生日期" }]}>
          <DatePicker format="YYYY-MM-DD" className="ui-control-full" />
        </CfgItem>
        <CfgItem name="pool_id" label="支出账户" rules={[{ required: true, message: "请选择支出账户" }]}>
          <Select aria-label="支出账户" placeholder="请选择分润支出的资金账户" options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} notFoundContent="暂无可用资金账户" />
        </CfgItem>
        <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
        <CfgItem name="note" label="备注">
          <Input.TextArea rows={3} placeholder="请输入分润备注（选填）" />
        </CfgItem>
        </BusinessRegistrationForm>
      </FieldConfigScope>
    </BusinessActionModal>
  );
}
