/** 返点记录：分次到账与来源订单追踪（REB-01 / A06）。 */
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
import { errorMessage, normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { orderTypeLabel } from "../shared/lib/labels";
import {
  DataTable,
  ErrorBanner,
  MoneyInput,
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
      message.success("返点记录已创建");
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
    { title: "返点单号", dataIndex: "rebate_no" },
    {
      title: "来源订单",
      render: (_v, row) => orders.find((order) => order.id === row.source_order_id)?.order_no ?? "-",
    },
    {
      title: "业务",
      render: (_v, row) => BUSINESS_MODE_LABEL[orders.find((order) => order.id === row.source_order_id)?.account_business_mode ?? ""] || "-",
    },
    {
      title: "类型",
      render: (_v, row) => {
        const order = orders.find((item) => item.id === row.source_order_id);
        return order ? orderTypeLabel(order.order_type, { ...ORDER_TYPE_LABEL }) : "-";
      },
    },
    {
      title: "产品",
      render: (_v, row) => {
        const order = orders.find((item) => item.id === row.source_order_id);
        return order ? [order.account_game_type, order.account_game_account].filter(Boolean).join(" / ") || "-" : "-";
      },
    },
    {
      title: "对方",
      render: (_v, row) => orders.find((order) => order.id === row.source_order_id)?.party_name || "-",
    },
    {
      title: "基数",
      dataIndex: "base_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    { title: "费率", dataIndex: "rate", align: "right", render: (v: string) => `${v}%` },
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
      <ErrorBanner error={error} onRetry={() => void load()} />

      <StatRow
        items={[
          { label: "返点记录数", kind: "count", amount: String(rows.length) },
          { label: "待结算", kind: "count", amount: String(pending), tone: pending ? "warn" : "plain" },
        ]}
      />

      <Card
        className="glass"
        title="返点记录"
        extra={
          <PermissionButton
            permission="order.event.post"
            type="primary"
            onClick={() => setCreateOpen(true)}
          >
            新增返点记录
          </PermissionButton>
        }
      >
        <DataTable<Rebate>
          columns={columns}
          rows={rows}
          page={1}
          pageSize={Math.max(rows.length, 10)}
          total={rows.length}
          emptyText="暂无返点记录"
          onPageChange={() => undefined}
        />
      </Card>

      <Modal title="新增返点记录" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <Form form={form} layout="vertical" onFinish={submitCreate} initialValues={{ collected_on: today() }}>
          <Form.Item name="source_order_id" label="来源订单" rules={[{ required: true }]}>
            <Select
              options={orders
                .filter((order) => ["ACTIVE", "COMPLETED"].includes(order.status))
                .map((order) => ({ value: order.id, label: order.order_no }))}
            />
          </Form.Item>
          <Form.Item name="base_amount" label="返点金额" rules={[{ required: true }]}>
            <MoneyInput />
          </Form.Item>
          <Form.Item name="rate" label="返点比例">
            <Input inputMode="decimal" suffix="%" placeholder="例如 5" />
          </Form.Item>
          <Form.Item name="collected_on" label="返点日期" rules={[{ required: true }]}>
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
        title={settleTarget ? `返点到账 · ${settleTarget.rebate_no}` : "返点到账"}
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
            <Select options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} />
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

