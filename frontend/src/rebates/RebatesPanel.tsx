/** 返点：归集、分次结算与未归集治理（REB-01 / A06）。 */
import { Card, Form, Input, Modal, Select, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  ordersApi,
  poolsApi,
  rebatesApi,
  type Order,
  type Pool,
  type Rebate,
} from "../shared/api/catalog";
import { errorMessage } from "../shared/api/client";
import { today } from "../shared/lib/format";
import {
  DataTable,
  ErrorBanner,
  MoneyText,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";

export function RebatesPanel() {
  const [rows, setRows] = useState<Rebate[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [settleTarget, setSettleTarget] = useState<Rebate | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();
  const [settleForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const [list, orderList, poolList] = await Promise.all([
        rebatesApi.list(),
        ordersApi.list(),
        poolsApi.list(),
      ]);
      setRows(list);
      setOrders(orderList);
      setPools(poolList);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = async (values: Record<string, unknown>) => {
    try {
      await rebatesApi.create({
        source_order_id: Number(values.source_order_id),
        base_amount: values.base_amount as string,
        rate: (values.rate as string) ?? "0",
        collected_on: values.collected_on as string,
      });
      message.success("返点归集已创建");
      setCreateOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitSettle = async (values: Record<string, unknown>) => {
    if (!settleTarget) return;
    try {
      await rebatesApi.settle(settleTarget.id, {
        gross_amount: values.gross_amount as string,
        platform_fee: (values.platform_fee as string) ?? "0",
        settled_on: values.settled_on as string,
        pool_id: Number(values.pool_id),
      });
      message.success("结算已登记，净额 = 到账 - 手续费");
      setSettleTarget(null);
      settleForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const pending = rows.filter((row) => row.status !== "SETTLED").length;

  const columns: ColumnsType<Rebate> = [
    { title: "归集号", dataIndex: "rebate_group_no" },
    {
      title: "来源订单",
      render: (_v, row) => orders.find((order) => order.id === row.source_order_id)?.order_no ?? "-",
    },
    {
      title: "基数",
      dataIndex: "base_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    { title: "费率", dataIndex: "rate", align: "right" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <PermissionButton
          permission="order.event.post"
          size="small"
          disabled={row.status === "SETTLED"}
          onClick={() => {
            setSettleTarget(row);
            settleForm.setFieldsValue({ settled_on: today() });
          }}
        >
          登记结算
        </PermissionButton>
      ),
    },
  ];

  return (
    <section className="ui-stack">
      <ErrorBanner message={error?.message} code={error?.code} />

      <StatRow
        items={[
          { label: "归集总数", kind: "count", amount: String(rows.length) },
          { label: "待结算", kind: "count", amount: String(pending), tone: pending ? "warn" : "plain" },
        ]}
      />

      <Card
        className="glass"
        title="返点归集"
        extra={
          <PermissionButton
            permission="order.event.post"
            type="primary"
            onClick={() => setCreateOpen(true)}
          >
            新增归集
          </PermissionButton>
        }
      >
        <DataTable<Rebate>
          columns={columns}
          rows={rows}
          page={1}
          pageSize={Math.max(rows.length, 10)}
          total={rows.length}
          emptyText="暂无返点归集"
          onPageChange={() => undefined}
        />
      </Card>

      <Modal title="新增返点归集" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <Form form={form} layout="vertical" onFinish={submitCreate} initialValues={{ collected_on: today() }}>
          <Form.Item name="source_order_id" label="来源订单" rules={[{ required: true }]}>
            <Select
              options={orders
                .filter((order) => ["ACTIVE", "COMPLETED"].includes(order.status))
                .map((order) => ({ value: order.id, label: order.order_no }))}
            />
          </Form.Item>
          <Form.Item name="base_amount" label="返点基数" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="rate" label="返点率">
            <Input placeholder="例如 0.10" />
          </Form.Item>
          <Form.Item name="collected_on" label="归集日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            新返点必须关联来源订单；返点不能独立创建为订单（REB-01-02）。
          </Typography.Paragraph>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit">
            创建
          </PermissionButton>
        </Form>
      </Modal>

      <Modal
        title={settleTarget ? `分次结算 · ${settleTarget.rebate_group_no}` : "分次结算"}
        open={Boolean(settleTarget)}
        onCancel={() => setSettleTarget(null)}
        footer={null}
      >
        <Form form={settleForm} layout="vertical" onFinish={submitSettle}>
          <Form.Item name="gross_amount" label="到账金额" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="platform_fee" label="手续费">
            <Input />
          </Form.Item>
          <Form.Item name="pool_id" label="回款池" rules={[{ required: true }]}>
            <Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.code} ${pool.name}` }))} />
          </Form.Item>
          <Form.Item name="settled_on" label="到账日期" rules={[{ required: true }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit">
            确认结算
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
