/** 分期：按业务合约类型分列，支持 HS / DFQ / TH / DG 的收款与风险处理。
 * 收款必须选择首付或期次；未结清不可换绑交付。 */
import { Card, Form, Input, Modal, Select, Space, Tabs, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  installmentsApi,
  ordersApi,
  type Installment,
  type InstallmentDisposition,
  type Order,
  type Schedule,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import { INSTALLMENT_STATUS_LABEL, today } from "../shared/lib/format";
import { orderTypeLabel } from "../shared/lib/labels";
import {
  DataTable,
  ErrorBanner,
  MoneyText,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";

const BUSINESS_MODE_LABEL: Record<string, string> = {
  SELF: "自营",
  DISTRIBUTION: "分销",
};

const ORDER_TYPE_LABEL: Record<string, string> = {
  HS: "回收",
  TH: "提号",
  DG: "代挂",
  DFQ: "代分期",
};

function ContractTable({
  contractType,
  reloadKey,
}: {
  contractType: string;
  reloadKey: number;
}) {
  const [rows, setRows] = useState<Installment[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [schedules, setSchedules] = useState<Record<number, Schedule[]>>({});
  const [dispositions, setDispositions] = useState<Record<number, InstallmentDisposition[]>>({});
  const [payTarget, setPayTarget] = useState<Installment | null>(null);
  const [deliverTarget, setDeliverTarget] = useState<Installment | null>(null);
  const [recoverTarget, setRecoverTarget] = useState<Installment | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [payForm] = Form.useForm();
  const [deliverForm] = Form.useForm();
  const [recoverForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const [list, orderList] = await Promise.all([installmentsApi.list(), ordersApi.list()]);
      const filtered = list.filter((item) => item.contract_type === contractType);
      setRows(filtered);
      setOrders(orderList);
      const entries = await Promise.all(
        filtered.map(async (item) => {
          const [scheduleRows, dispositionRows] = await Promise.all([
            installmentsApi.schedules(item.id),
            installmentsApi.dispositions(item.id),
          ]);
          return [item.id, scheduleRows, dispositionRows] as const;
        }),
      );
      setSchedules(Object.fromEntries(entries.map(([id, scheduleRows]) => [id, scheduleRows])));
      setDispositions(Object.fromEntries(entries.map(([id, _scheduleRows, dispositionRows]) => [id, dispositionRows])));
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, [contractType]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const submitPay = async (values: Record<string, unknown>) => {
    if (!payTarget) return;
    try {
      await installmentsApi.pay(payTarget.id, {
        amount: values.amount as string,
        paid_on: values.paid_on as string,
        period_no: values.period_no === undefined ? undefined : Number(values.period_no),
      });
      message.success("收款已登记");
      setPayTarget(null);
      payForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitDeliver = async (values: Record<string, unknown>) => {
    if (!deliverTarget) return;
    try {
      await installmentsApi.deliver(deliverTarget.id, {
        delivery_mode: values.delivery_mode as string,
        delivered_on: values.delivered_on as string,
        note: values.note as string,
      });
      message.success("已完成交付，不新增现金流");
      setDeliverTarget(null);
      deliverForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitRecover = async (values: Record<string, unknown>) => {
    if (!recoverTarget) return;
    try {
      await installmentsApi.recover(recoverTarget.id, {
        occurred_on: values.occurred_on as string,
        note: values.note as string,
      });
      message.success("逾期账号已登记回收");
      setRecoverTarget(null);
      recoverForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  // 只读展示口径：总应收 = 首付 + 每期 × 期数。
  const receivable = (row: Installment) =>
    Number(row.down_payment) + Number(row.per_period) * row.periods;

  const totalReceivable = rows.reduce((sum, row) => sum + receivable(row), 0).toFixed(2);
  const totalPaid = rows.reduce((sum, row) => sum + Number(row.paid_amount), 0).toFixed(2);

  const columns: ColumnsType<Installment> = [
    { title: "合约号", dataIndex: "inst_no" },
    {
      title: "订单",
      render: (_v, row) => orders.find((order) => order.id === row.order_id)?.order_no ?? row.order_id,
    },
    {
      title: "业务",
      render: (_v, row) => BUSINESS_MODE_LABEL[orders.find((order) => order.id === row.order_id)?.account_business_mode ?? ""] || "-",
    },
    {
      title: "类型",
      render: (_v, row) => {
        const order = orders.find((item) => item.id === row.order_id);
        return order ? orderTypeLabel(order.order_type, { ...ORDER_TYPE_LABEL }) : "-";
      },
    },
    {
      title: "产品",
      render: (_v, row) => {
        const order = orders.find((item) => item.id === row.order_id);
        return order ? [order.account_game_type, order.account_game_account].filter(Boolean).join(" / ") || "-" : "-";
      },
    },
    {
      title: "对方",
      render: (_v, row) => orders.find((order) => order.id === row.order_id)?.party_name || "-",
    },
    {
      title: "总应收",
      align: "right",
      render: (_v, row) => <MoneyText value={receivable(row).toFixed(2)} />,
    },
    {
      title: "服务费",
      dataIndex: "service_fee",
      align: "right",
      render: (v: string) => <MoneyText value={v ?? "0"} />,
    },
    {
      title: "每期服务费",
      dataIndex: "per_period_service_fee",
      align: "right",
      render: (v: string) => <MoneyText value={v ?? "0"} />,
    },
    {
      title: "已收",
      dataIndex: "paid_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "坏账",
      dataIndex: "bad_debt_amount",
      align: "right",
      render: (v: string | undefined) => <MoneyText value={v ?? "0"} />,
    },
    {
      title: "剩余",
      align: "right",
      render: (_v, row) => (
        <MoneyText
          value={(
            receivable(row) - Number(row.paid_amount) - Number(row.bad_debt_amount ?? 0)
          ).toFixed(2)}
        />
      ),
    },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={INSTALLMENT_STATUS_LABEL[v] ?? v} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <Space>
          <PermissionButton
            permission="order.event.post"
            size="small"
            disabled={["DELIVERED", "CLOSED", "CANCELLED"].includes(row.status)}
            onClick={() => {
              setPayTarget(row);
              payForm.setFieldsValue({ paid_on: today() });
            }}
          >
            登记收款
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            size="small"
            type="primary"
            disabled={row.status !== "SETTLED"}
            onClick={() => {
              setDeliverTarget(row);
              deliverForm.setFieldsValue({ delivered_on: today() });
            }}
          >
            换绑交付
          </PermissionButton>
          <PermissionButton
            permission="order.exception.approve"
            size="small"
            disabled={
              !(["CLOSED", "OVERDUE", "DEFAULTED"].includes(row.status))
              || (dispositions[row.id] ?? []).some((item) => item.action === "RECOVER")
            }
            onClick={() => {
              setRecoverTarget(row);
              recoverForm.setFieldsValue({ occurred_on: today() });
            }}
          >
            登记回收
          </PermissionButton>
          {row.status === "CLOSED"
            && (dispositions[row.id] ?? []).some((item) => item.action === "RECOVER")
            && !(dispositions[row.id] ?? []).some((item) => item.action === "RESELL") ? (
              <Typography.Text type="secondary">请到库存中心售出，系统自动关联</Typography.Text>
            ) : null}
        </Space>
      ),
    },
  ];

  const scheduleColumns: ColumnsType<Schedule> = [
    { title: "期次", render: (_v, s) => (s.period_no === 0 ? "首付" : `第 ${s.period_no} 期`) },
    { title: "到期日", dataIndex: "due_on" },
    {
      title: "应收",
      dataIndex: "due_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "已收",
      dataIndex: "received_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={INSTALLMENT_STATUS_LABEL[v] ?? v} /> },
  ];

  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />

      <StatRow
        items={[
          { label: "合约数", kind: "count", amount: String(rows.length) },
          { label: "总应收", amount: totalReceivable },
          { label: "已收合计", amount: totalPaid },
          {
            label: "逾期合约",
            kind: "count",
            amount: String(rows.filter((r) => r.status === "OVERDUE").length),
            tone: rows.some((r) => r.status === "OVERDUE") ? "warn" : "plain",
          },
        ]}
      />

      <Card className="glass">
        <DataTable<Installment>
          columns={columns}
          rows={rows}
          page={1}
          pageSize={Math.max(rows.length, 10)}
          total={rows.length}
          emptyText="暂无分期合约"
          onPageChange={() => undefined}
          expandable={{
            expandedRowRender: (row) => (
              <Space direction="vertical" size="middle" className="installment-detail-stack">
                <DataTable<Schedule>
                  rows={schedules[row.id] ?? []}
                  page={1}
                  pageSize={20}
                  total={(schedules[row.id] ?? []).length}
                  onPageChange={() => undefined}
                  emptyText="暂无期次"
                  columns={scheduleColumns}
                />
                {(dispositions[row.id] ?? []).length > 0 && (
                  <Typography.Paragraph>
                    处置记录：{(dispositions[row.id] ?? []).map((item) =>
                      `${item.action === "RECOVER" ? "回收" : "出售"}（${item.occurred_on}）`,
                    ).join("、")}
                  </Typography.Paragraph>
                )}
              </Space>
            ),
          }}
        />
      </Card>

      <Modal
        title={payTarget ? `分期收款 · ${payTarget.inst_no}` : "分期收款"}
        open={Boolean(payTarget)}
        onCancel={() => setPayTarget(null)}
        footer={null}
      >
        <Form form={payForm} layout="vertical" onFinish={submitPay}>
          <Form.Item name="period_no" label="期次（0=首付，留空按到期顺序）">
            <Select
              allowClear
              options={(schedules[payTarget?.id ?? 0] ?? []).map((schedule) => ({
                value: schedule.period_no,
                label: schedule.period_no === 0 ? "首付" : `第 ${schedule.period_no} 期`,
              }))}
            />
          </Form.Item>
          <Form.Item name="amount" label="本次实收" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="paid_on" label="收款日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit">
            确认收款
          </PermissionButton>
        </Form>
      </Modal>

      <Modal
        title={recoverTarget ? `逾期回收 · ${recoverTarget.inst_no}` : "逾期回收"}
        open={Boolean(recoverTarget)}
        onCancel={() => setRecoverTarget(null)}
        footer={null}
      >
        <Form form={recoverForm} layout="vertical" onFinish={submitRecover}>
          <Form.Item name="occurred_on" label="回收日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item name="note" label="回收说明" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <PermissionButton permission="order.exception.approve" type="primary" htmlType="submit">
            确认回收
          </PermissionButton>
        </Form>
      </Modal>

      <Modal
        title={deliverTarget ? `换绑交付 · ${deliverTarget.inst_no}` : "换绑交付"}
        open={Boolean(deliverTarget)}
        onCancel={() => setDeliverTarget(null)}
        footer={null}
      >
        <Form form={deliverForm} layout="vertical" onFinish={submitDeliver}>
          <Form.Item name="delivery_mode" label="交付方式" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "PLATFORM_OPERATOR", label: "平台/本方操作换绑" },
                { value: "CUSTOMER_SELF", label: "客户自行换绑" },
              ]}
            />
          </Form.Item>
          <Form.Item name="delivered_on" label="换绑日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item name="note" label="换绑凭证" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            仅已结清合约可交付；DELIVER 无金额、不生成现金流，不再确认收入。
          </Typography.Paragraph>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit">
            确认交付
          </PermissionButton>
        </Form>
      </Modal>
    </section>
  );
}

export function InstallmentsPanel() {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <Tabs
      defaultActiveKey="stock"
      tabBarExtraContent={
        <PermissionButton permission="finance.read" size="small" onClick={() => setReloadKey((key) => key + 1)}>
          刷新
        </PermissionButton>
      }
      items={[
        {
          key: "stock",
          label: "分期出售",
          children: <ContractTable contractType="STOCK_SALE" reloadKey={reloadKey} />,
        },
        {
          key: "advance",
          label: "代分期",
          children: <ContractTable contractType="ADVANCE_PURCHASE" reloadKey={reloadKey} />,
        },
        {
          key: "pickup",
          label: "提号分期",
          children: <ContractTable contractType="PICKUP_SALE" reloadKey={reloadKey} />,
        },
        {
          key: "consignment",
          label: "代挂分期",
          children: <ContractTable contractType="CONSIGNMENT_SALE" reloadKey={reloadKey} />,
        },
      ]}
    />
  );
}

