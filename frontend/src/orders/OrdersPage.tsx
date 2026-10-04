/** 业务中心：业务作业 / 订单台账 / 库存 / 分期 / 返点（页面原型 §3）。
 * 资金类动作一律不在列表内直接过账：必须打开详情弹窗发起。 */
import { Card, Form, Input, Modal, Select, Space, Tabs, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  accountsApi,
  counterpartiesApi,
  customersApi,
  ordersApi,
  orderTypesApi,
  type Account,
  type Counterparty,
  type Customer,
  type Order,
  type OrderType,
} from "../shared/api/catalog";
import { errorMessage } from "../shared/api/client";
import { EVENT_TYPE_LABEL, today } from "../shared/lib/format";
import { InventoryPanel } from "../accounts/InventoryPanel";
import { InstallmentsPanel } from "../installments/InstallmentsPanel";
import { RebatesPanel } from "../rebates/RebatesPanel";
import {
  DataTable,
  ErrorBanner,
  PageHeader,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";

interface EventForm {
  event_type: string;
  amount?: string;
  occurred_on: string;
  portion: string;
  note?: string;
}

export function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [types, setTypes] = useState<OrderType[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [eventOrder, setEventOrder] = useState<Order | null>(null);
  const [filterType, setFilterType] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [form] = Form.useForm();
  const [eventForm] = Form.useForm<EventForm>();

  const load = useCallback(async () => {
    try {
      const [list, typeList, customerList, cpList, accountList] = await Promise.all([
        ordersApi.list(),
        orderTypesApi.list(),
        customersApi.list(),
        counterpartiesApi.list(),
        accountsApi.list(),
      ]);
      setOrders(list);
      setTypes(typeList);
      setCustomers(customerList);
      setCounterparties(cpList);
      setAccounts(accountList);
      setLoadError(null);
    } catch (error) {
      setLoadError(normalizeError(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = async (values: Record<string, unknown>) => {
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
      setCreateOpen(false);
      form.resetFields();
      await load();
    } catch (error) {
      setLoadError(normalizeError(error));
    }
  };

  const submitEvent = async (values: EventForm) => {
    if (!eventOrder) return;
    try {
      const result = await ordersApi.postEvent(eventOrder.id, {
        event_type: values.event_type,
        amount: values.amount || "0",
        occurred_on: values.occurred_on,
        portion: values.portion,
        note: values.note,
      });
      message.success(
        result.cashflow_no
          ? `已过账，流水号 ${result.cashflow_no}`
          : "已登记（无金额事件，不产生现金流）",
      );
      setEventOrder(null);
      eventForm.resetFields();
      await load();
    } catch (error) {
      setLoadError(normalizeError(error));
    }
  };

  const filtered = filterType ? orders.filter((order) => order.order_type === filterType) : orders;
  const pending = filtered.filter((order) => ["DRAFT", "ACTIVE"].includes(order.status));
  const thOpen = orders.filter((o) => o.order_type === "TH" && o.status === "ACTIVE").length;

  const worklistColumns: ColumnsType<Order> = [
    { title: "订单号", dataIndex: "order_no" },
    { title: "业务", dataIndex: "order_type" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    { title: "成交日", dataIndex: "trade_date" },
    {
      title: "下一步",
      render: (_v, row) => (
        <PermissionButton
          permission="order.event.post"
          type="link"
          size="small"
          onClick={() => setEventOrder(row)}
        >
          登记事件
        </PermissionButton>
      ),
    },
  ];

  const ledgerColumns: ColumnsType<Order> = [
    { title: "订单号", dataIndex: "order_no" },
    { title: "业务", dataIndex: "order_type" },
    { title: "资金性质", dataIndex: "capital_type" },
    { title: "成交日", dataIndex: "trade_date" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <PermissionButton
          permission="order.event.post"
          type="link"
          size="small"
          onClick={() => setEventOrder(row)}
        >
          登记事件
        </PermissionButton>
      ),
    },
  ];

  return (
    <section className="ui-stack">
      <PageHeader
        title="业务中心"
        description="业务作业、订单台账、库存、分期与返点统一在此；资金操作不在列表内直接过账。"
        actions={
          <PermissionButton
            permission="order.create"
            type="primary"
            onClick={() => setCreateOpen(true)}
          >
            新建业务
          </PermissionButton>
        }
      />

      <ErrorBanner message={loadError?.message} code={loadError?.code} />

      <StatRow
        items={[
          { label: "订单总数", kind: "count", amount: String(orders.length) },
          { label: "待处理", kind: "count", amount: String(pending.length) },
          { label: "TH 未闭环", kind: "count", amount: String(thOpen), tone: thOpen ? "warn" : "plain" },
        ]}
      />

      <Tabs
        defaultActiveKey="worklist"
        items={[
          {
            key: "worklist",
            label: "业务作业",
            children: (
              <Card className="glass">
                <Space className="ui-filter-bar" style={{ marginBottom: 12 }}>
                  <Select
                    allowClear
                    placeholder="业务类型"
                    style={{ width: 180 }}
                    value={filterType}
                    onChange={(value) => {
                      setFilterType(value);
                      setPage(1);
                    }}
                    options={types.map((type) => ({
                      value: type.code,
                      label: `${type.code} ${type.name}`,
                    }))}
                  />
                  <Typography.Text type="secondary">
                    资金操作不在列表内直接过账，请打开详情发起
                  </Typography.Text>
                </Space>
                <DataTable<Order>
                  columns={worklistColumns}
                  rows={pending}
                  page={1}
                  pageSize={Math.max(pending.length, 10)}
                  total={pending.length}
                  emptyText="当前没有待处理业务"
                  onPageChange={() => undefined}
                />
              </Card>
            ),
          },
          {
            key: "orders",
            label: "订单台账",
            children: (
              <Card className="glass">
                <DataTable<Order>
                  columns={ledgerColumns}
                  rows={filtered}
                  page={page}
                  pageSize={pageSize}
                  total={filtered.length}
                  emptyText="暂无订单"
                  onPageChange={(nextPage, nextSize) => {
                    setPage(nextPage);
                    setPageSize(nextSize);
                  }}
                />
              </Card>
            ),
          },
          { key: "inventory", label: "库存", children: <InventoryPanel /> },
          { key: "installments", label: "分期", children: <InstallmentsPanel /> },
          { key: "rebates", label: "返点", children: <RebatesPanel /> },
        ]}
      />

      <Modal title="新建业务" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <Form
          form={form}
          layout="vertical"
          onFinish={submitCreate}
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
                label: `${c.counterparty_no} ${c.display_name}（${c.type}）`,
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

      <Modal
        title={eventOrder ? `登记事件 · ${eventOrder.order_no}` : "登记事件"}
        open={Boolean(eventOrder)}
        onCancel={() => setEventOrder(null)}
        footer={null}
      >
        <Form
          form={eventForm}
          layout="vertical"
          onFinish={submitEvent}
          initialValues={{ occurred_on: today(), portion: "PRINCIPAL", event_type: "BUY" }}
        >
          <Form.Item name="event_type" label="事件类型" rules={[{ required: true }]}>
            <Select
              options={Object.entries(EVENT_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          <Form.Item name="amount" label="金额（DELIVER 留空）">
            <Input />
          </Form.Item>
          <Form.Item name="portion" label="资金份额">
            <Select
              options={[
                { value: "PRINCIPAL", label: "本金" },
                { value: "PROFIT", label: "利润" },
                { value: "GROSS", label: "总额" },
              ]}
            />
          </Form.Item>
          <Form.Item name="occurred_on" label="发生日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item name="note" label="凭证说明（DELIVER 必填）">
            <Input.TextArea rows={2} />
          </Form.Item>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit">
            提交过账
          </PermissionButton>
        </Form>
      </Modal>
    </section>
  );
}

function normalizeError(err: unknown): { message: string; code?: string } {
  const detail = (err as { response?: { data?: { detail?: { message?: string; code?: string } } } })
    ?.response?.data?.detail;
  if (detail?.message) return { message: detail.message, code: detail.code };
  return { message: errorMessage(err) };
}
