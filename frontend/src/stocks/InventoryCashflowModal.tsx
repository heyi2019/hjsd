import dayjs, { type Dayjs } from "dayjs";
import { DatePicker, Form, Input, Select } from "antd";
import { useEffect } from "react";
import { cashflowsApi, type Account, type Pool } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { appMessage } from "../shared/ui/appFeedback";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../orders/ConfigurableField";
import { BusinessActionModal, BusinessRegistrationForm, MoneyInput } from "../shared/ui";
import { requiredMoneyRules } from "../shared/lib/validators";

export type InventoryCashflowTarget = {
  account: Account;
  orderId: number;
  orderNo: string;
};

export function InventoryCashflowModal({
  target,
  pools,
  onClose,
  onCreated,
}: {
  target: InventoryCashflowTarget | null;
  pools: Pool[];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [form] = Form.useForm();
  const direction = Form.useWatch<string>("direction", form) ?? "OUT";

  useEffect(() => {
    if (!target) return;
    form.resetFields();
    form.setFieldsValue({
      occurred_on: dayjs(today()),
      direction: "OUT",
      category: "OTHER",
      pool_id: pools[0]?.id,
    });
  }, [form, pools, target]);

  const submit = async (values: {
    occurred_on?: Dayjs;
    direction?: string;
    category?: string;
    amount: string;
    pool_id?: number;
    note: string;
  }) => {
    if (!target) return;
    try {
      const flowDirection = values.direction === "IN" ? "IN" : "OUT";
      await cashflowsApi.createForOrder(target.orderId, {
        pool_id: values.pool_id,
        occurred_on: (values.occurred_on ?? dayjs(today())).format("YYYY-MM-DD"),
        direction: flowDirection,
        nature: flowDirection === "IN" ? "BUSINESS_IN" : "BUSINESS_OUT",
        fund_nature: "BUSINESS",
        accounting_attribute: flowDirection === "IN" ? "SELF_REVENUE" : "OPERATING_EXPENSE",
        category: values.category ?? "OTHER",
        amount: values.amount,
        note: values.note,
      });
      appMessage.success("资金收支已登记");
      form.resetFields();
      onClose();
      await onCreated();
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  return (
    <BusinessActionModal
      title={target ? `资金收支 · ${target.orderNo}` : "资金收支"}
      fieldCount={6}
      open={Boolean(target)}
      okText="确定"
      onCancel={onClose}
      onOk={() => void form.submit()}
    >
      <BusinessRegistrationForm
        layout="horizontal"
        labelAlign="left"
        labelCol={{ flex: "108px" }}
        wrapperCol={{ flex: "auto" }}
        scope="FUNDFLOW"
        form={form}
        onFinish={submit}
      >
        <FieldConfigScope scope="FUNDFLOW" active={Boolean(target)}>
        <CfgItem name="occurred_on" label="发生日期" rules={[{ required: true, message: "请选择发生日期" }]}>
          <DatePicker format="YYYY-MM-DD" className="ui-control-full" />
        </CfgItem>
        <CfgItem name="direction" label="资金流向" rules={[{ required: true, message: "请选择资金流向" }]}>
          <Select
            aria-label="资金流向"
            options={[{ value: "IN", label: "收入" }, { value: "OUT", label: "支出" }]}
            onChange={(value) => form.setFieldValue("category", value === "IN" ? "OTHER" : "OTHER")}
          />
        </CfgItem>
        <CfgItem name="category" label="资金原因" rules={[{ required: true, message: "请选择资金原因" }]}>
          <Select
            options={direction === "IN"
              ? [{ value: "SALE", label: "售出/回款" }, { value: "OTHER", label: "其他收入" }]
              : [{ value: "BUY", label: "买入/采购" }, { value: "OTHER", label: "其他支出" }]}
          />
        </CfgItem>
        <CfgItem name="amount" label="金额" rules={requiredMoneyRules("金额")}>
          <MoneyInput placeholder="请输入资金金额" />
        </CfgItem>
        <CfgItem name="pool_id" label="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}>
          <Select
            aria-label="资金账户"
            placeholder="请选择这笔收支的资金账户"
            options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))}
            notFoundContent="暂无可用资金账户"
          />
        </CfgItem>
        <CfgItem name="note" label="收支备注" rules={[{ required: true, message: "请输入收支备注" }]}>
          <Input.TextArea rows={3} placeholder="请输入收支备注" />
        </CfgItem>
        <CustomFieldSection testIdSuffix="inventory-cashflow" />
        </FieldConfigScope>
      </BusinessRegistrationForm>
    </BusinessActionModal>
  );
}
