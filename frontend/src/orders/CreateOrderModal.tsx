/** 新建业务弹窗（从业务中心提取为共享组件，2026-10-13）。
 *  工作台「新建业务」入口卡点击后直接在本页打开，不再跳转业务中心。
 *  数据自加载：打开时才拉 业务类型/客户/合作方/账号，关闭不保留。 */
import { Form, Input, Modal, message } from "antd";
import { Select } from "../shared/ui";
import { useEffect, useState } from "react";
import {
  accountsApi,
  counterpartiesApi,
  customersApi,
  ordersApi,
  orderTypesApi,
  type Account,
  type Counterparty,
  type Customer,
  type OrderType,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { COUNTERPARTY_TYPE_LABEL } from "../shared/lib/labels";
import { ErrorBanner, PermissionButton } from "../shared/ui";

export function CreateOrderModal(props: {
  open: boolean;
  onClose: () => void;
  /** 建单成功后的刷新回调（页面重新拉列表）。 */
  onCreated: () => void | Promise<void>;
}) {
  const [types, setTypes] = useState<OrderType[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    void (async () => {
      try {
        const [typeList, customerList, cpList, accountList] = await Promise.all([
          orderTypesApi.list(),
          customersApi.list(),
          counterpartiesApi.list(),
          accountsApi.list(),
        ]);
        if (cancelled) return;
        setTypes(typeList);
        setCustomers(customerList);
        setCounterparties(cpList);
        setAccounts(accountList);
        setLoadError(null);
      } catch (error) {
        if (!cancelled) setLoadError(normalizeError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.open]);

  const submit = async (values: Record<string, unknown>) => {
    try {
      await ordersApi.create({
        order_type: values.order_type as string,
        trade_date: values.trade_date as string,
        account_id: (values.account_id as number) ?? undefined,
        note: values.note as string,
        customer_roles: values.customer_id
          ? [{ customer_id: values.customer_id as number, role: values.customer_role as string }]
          : [],
        counterparty_roles: values.counterparty_id
          ? [
              {
                counterparty_id: values.counterparty_id as number,
                role: values.counterparty_role as string,
              },
            ]
          : [],
      });
      message.success("订单已创建");
      props.onClose();
      form.resetFields();
      await props.onCreated();
    } catch (error) {
      setLoadError(normalizeError(error));
    }
  };

  return (
    <Modal title="新建业务" open={props.open} onCancel={props.onClose} footer={null}>
      <ErrorBanner error={loadError} />
      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        initialValues={{ trade_date: today(), customer_role: "SELLER", counterparty_role: "PEER" }}
      >
        <Form.Item name="order_type" label="业务类型" rules={[{ required: true }]}>
          <Select
            options={types.map((type) => ({ value: type.code, label: `${type.code} ${type.name}` }))}
          />
        </Form.Item>
        <Form.Item name="trade_date" label="成交日期" rules={[{ required: true }]}>
          <Input placeholder="YYYY-MM-DD" />
        </Form.Item>
        <Form.Item name="account_id" label="关联账号（HS/DFQ 必填）">
          <Select
            allowClear
            placeholder="请选择账号"
            notFoundContent="暂无账号：请先到「库存」页签新增账号后再回到此处关联"
            options={accounts.map((account) => ({
              value: account.id,
              label: `${account.account_no} ${account.game_account ?? ""}`,
            }))}
          />
        </Form.Item>
        <Form.Item name="customer_id" label="客户">
          <Select
            allowClear
            options={customers.map((c) => ({ value: c.id, label: `${c.customer_no} ${c.display_name}` }))}
          />
        </Form.Item>
        <Form.Item name="customer_role" label="客户角色">
          <Select
            options={[
              { value: "SELLER", label: "卖家" },
              { value: "BUYER", label: "买家" },
              { value: "CONSIGNOR", label: "委托方" },
              { value: "INSTALLMENT_CUSTOMER", label: "分期客户" },
            ]}
          />
        </Form.Item>
        <Form.Item name="counterparty_id" label="合作方（同行/供货方/平台）">
          <Select
            allowClear
            options={counterparties.map((c) => ({
              value: c.id,
              label: `${c.display_name}（${COUNTERPARTY_TYPE_LABEL[c.type] ?? c.type}）`,
            }))}
          />
        </Form.Item>
        <Form.Item name="counterparty_role" label="合作方角色">
          <Select
            options={[
              { value: "PEER", label: "同行" },
              { value: "SUPPLIER", label: "供货方" },
              { value: "PLATFORM", label: "平台" },
            ]}
          />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input.TextArea rows={2} />
        </Form.Item>
        <PermissionButton permission="order.create" type="primary" htmlType="submit">
          创建草稿
        </PermissionButton>
      </Form>
    </Modal>
  );
}
