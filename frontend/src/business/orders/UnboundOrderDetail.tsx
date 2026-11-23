import { Descriptions, Spin, Typography } from "antd";
import { useEffect, useState } from "react";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { ordersApi } from "../../shared/api/orders.api";
import type { Order, OrderCashflow, OrderRebate } from "../../shared/api/types/orders";
import type { OrderEvent } from "../../shared/api/types/order-events";
import { configurableLabel } from "../../shared/lib/optionSets";
import { money } from "../../shared/lib/format";
import { DataTable, ErrorBanner } from "../../shared/ui";

/** 历史订单不自动绑定库存，但订单自身的事实仍须可查询。 */
export function UnboundOrderDetail({ orderId }: { orderId: number }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<NormalizedError | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setOrder(null);
    setError(null);
    void ordersApi.get(orderId, { fresh: true }).then((value) => {
      if (active) setOrder(value);
    }).catch((cause) => {
      if (active) setError(normalizeError(cause));
    });
    return () => { active = false; };
  }, [orderId, attempt]);

  if (error) return <ErrorBanner error={error} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!order) return <Spin size="small" />;
  const snapshot = order.account_snapshot;
  return <div className="order-detail">
    <Typography.Text type="secondary">该订单未关联库存账号，以下为订单记录。</Typography.Text>
    <Descriptions size="small" column={2}>
      <Descriptions.Item label="业务日期">{order.trade_date}</Descriptions.Item>
      <Descriptions.Item label="游戏账号/产品">{snapshot?.game_account || "-"}</Descriptions.Item>
      <Descriptions.Item label="游戏/产品类型">{snapshot?.game_type || "-"}</Descriptions.Item>
      <Descriptions.Item label="渠道 / 区服">{snapshot?.channel_region || "-"}</Descriptions.Item>
      <Descriptions.Item label="绑定手机号">{snapshot?.bound_phone || "-"}</Descriptions.Item>
      <Descriptions.Item label="有无二次">{snapshot?.has_secondary == null ? "-" : snapshot.has_secondary ? "有" : "无"}</Descriptions.Item>
      <Descriptions.Item label="账号描述" span={2}>{snapshot?.account_description || "-"}</Descriptions.Item>
      <Descriptions.Item label="订单备注">{order.note || "-"}</Descriptions.Item>
    </Descriptions>
    <Typography.Text strong>操作明细</Typography.Text>
    <DataTable<OrderEvent> size="small" rowKey="event_no" rows={order.events ?? []} page={1} pageSize={10} total={order.events?.length ?? 0} onPageChange={() => undefined} columns={[
      { title: "动作", dataIndex: "event_type", render: (value: string) => configurableLabel("ORDER_EVENT_TYPE", value) },
      { title: "日期", dataIndex: "occurred_on" },
      { title: "金额", dataIndex: "amount", render: (value: string) => money(value) },
      { title: "操作人", dataIndex: "operator", render: (value: string | null) => value || "-" },
      { title: "备注", dataIndex: "note", render: (value: string | null) => value || "-" },
    ]} />
    <Typography.Text strong>资金明细</Typography.Text>
    <DataTable<OrderCashflow> size="small" rowKey="flow_no" rows={order.cashflows ?? []} page={1} pageSize={10} total={order.cashflows?.length ?? 0} onPageChange={() => undefined} columns={[
      { title: "流水号", dataIndex: "flow_no" },
      { title: "日期", dataIndex: "occurred_on" },
      { title: "方向", dataIndex: "direction", render: (value: string) => configurableLabel("FUND_FLOW_DIRECTION", value) },
      { title: "金额", dataIndex: "amount", render: (value: string) => money(value) },
      { title: "备注", dataIndex: "note", render: (value: string | null) => value || "-" },
    ]} />
    <Typography.Text strong>返点明细</Typography.Text>
    <DataTable<OrderRebate> size="small" rowKey="rebate_no" rows={order.rebates ?? []} page={1} pageSize={10} total={order.rebates?.length ?? 0} onPageChange={() => undefined} columns={[
      { title: "返点单号", dataIndex: "rebate_no" },
      { title: "类型", dataIndex: "rebate_type", render: (value: string) => configurableLabel("REBATE_TYPE", value) },
      { title: "收到日期", dataIndex: "collected_on" },
      { title: "金额", dataIndex: "amount", render: (value: string) => money(value) },
    ]} />
  </div>;
}
