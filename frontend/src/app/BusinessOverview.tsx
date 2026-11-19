import { Card, Descriptions, List, Modal, Spin, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { notificationsApi } from "../shared/api/misc.api";
import { ordersApi } from "../shared/api/orders.api";
import type { AccountExecutionDetail } from "../shared/api/types/account-execution";
import type { NotificationItem } from "../shared/api/types/common";
import type { Order } from "../shared/api/types/orders";
import { formatDateTimeMinute, money } from "../shared/lib/format";
import { StatRow } from "../shared/ui";

export function BusinessOverview({
  orderSummary,
  inventoryCount,
  inventoryOverdueCount,
  installmentCount,
  overdueInstallmentCount,
  ordersError = false,
  loading,
  personalOrders,
  personalCustomers,
  personalOrdersError = false,
  onPersonalOrdersClick,
  onPersonalCustomersClick,
  personalEarnings,
  personalEarningsError = false,
  onPersonalEarningsClick,
  onInventoryClick,
  onOrdersClick,
  onInstallmentsClick,
  onOverdueInstallmentsClick,
  onInventoryOverdueClick,
}: {
  orderSummary: { total_count: number; completed_count: number } | null;
  inventoryCount: number | null;
  inventoryAgingCount: number | null;
  inventoryOverdueCount: number | null;
  installmentCount: number | null;
  overdueInstallmentCount: number | null;
  profitNotificationsEnabled?: boolean;
  overdueInstallmentsEnabled?: boolean;
  ordersError?: boolean;
  loading: boolean;
  personalOrders?: number;
  personalCustomers?: number;
  personalOrdersError?: boolean;
  onPersonalOrdersClick?: () => void;
  onPersonalCustomersClick?: () => void;
  personalEarnings?: string | null;
  personalEarningsError?: boolean;
  onPersonalEarningsClick?: () => void;
  onInventoryClick?: () => void;
  onOrdersClick?: () => void;
  onInstallmentsClick?: () => void;
  onOverdueInstallmentsClick?: () => void;
  onInventoryOverdueClick?: () => void;
}) {
  const amount = (value: number | null) => loading ? null : value;
  return (
    <section aria-label="我的业务总览" className="ui-stack">
      <StatRow className="ui-stat-row--overview" items={[
        ...(personalOrders !== undefined ? [{ label: "我的当期订单", kind: "count" as const, amount: personalOrdersError ? null : String(personalOrders), hint: "入库 / 售出操作人", onClick: onPersonalOrdersClick, testId: "dashboard-personal-orders" }] : []),
        ...(personalEarnings !== undefined ? [{ label: "我的当期收益", amount: personalEarningsError ? null : personalEarnings, hint: "当期 · 本人分润基数", onClick: onPersonalEarningsClick, testId: "dashboard-personal-earnings" }] : []),
        { label: "在库账号", kind: "count", amount: amount(inventoryCount), onClick: onInventoryClick, testId: "dashboard-inventory" },
        { label: "订单总量", kind: "count", amount: ordersError || !orderSummary ? null : amount(orderSummary.total_count), onClick: onOrdersClick, testId: "dashboard-orders" },
        ...(personalCustomers !== undefined ? [{ label: "我的当期客户数", kind: "count" as const, amount: ordersError ? null : String(personalCustomers), onClick: onPersonalCustomersClick, testId: "dashboard-personal-customers" }] : []),
        { label: "分期合约", kind: "count", amount: amount(installmentCount), onClick: onInstallmentsClick, testId: "dashboard-installments" },
        { label: "逾期合约", kind: "count", amount: amount(overdueInstallmentCount), tone: "warn", onClick: onOverdueInstallmentsClick, testId: "dashboard-overdue-installments" },
        { label: "在库超期账号", kind: "count", amount: amount(inventoryOverdueCount), hint: "未售超过 30 天", tone: "warn", onClick: onInventoryOverdueClick, testId: "dashboard-inventory-overdue" },
      ]} />
    </section>
  );
}

type ProfitNotificationDetail = {
  notification: NotificationItem;
  order: Order;
  execution: AccountExecutionDetail;
};

function ProfitNotificationModal({ open, onClose, onRead }: { open: boolean; onClose: () => void; onRead?: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<ProfitNotificationDetail[]>([]);
  const [unavailableCount, setUnavailableCount] = useState(0);
  const onReadRef = useRef(onRead);

  useEffect(() => {
    onReadRef.current = onRead;
  }, [onRead]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetails([]);
    setUnavailableCount(0);
    void notificationsApi.list({ limit: 200, unread_only: true, notification_type: "PROFIT_ALLOCATED" })
      .then(async ({ items }) => {
        const profitNotifications = items.filter((item) => item.notification_type === "PROFIT_ALLOCATED" && item.entity_type === "order");
        const loaded = await Promise.allSettled(profitNotifications.map(async (notification) => {
          const page = await ordersApi.listPage({ keyword: notification.entity_id, limit: 20, offset: 0 });
          const order = page.items.find((item) => item.order_no === notification.entity_id);
          if (!order) return null;
          const execution = await ordersApi.executionDetail(order.id);
          return { notification, order, execution };
        }));
        if (cancelled) return;
        const available = loaded.flatMap((item) => item.status === "fulfilled" && item.value !== null ? [item.value] : []);
        setDetails(available);
        setUnavailableCount(profitNotifications.length - available.length);
        setLoading(false);
        if (available.length) {
          void Promise.all(available.map((item) => notificationsApi.markRead(item.notification.id))).then(() => onReadRef.current?.());
        }
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "分润通知详情加载失败");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Modal open={open} title="订单分润通知详情" onCancel={onClose} footer={null} width={720} destroyOnHidden>
      {loading ? <div className="dashboard-notification-detail__loading"><Spin /></div> : null}
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {!loading && !error && unavailableCount > 0 ? <Typography.Text type="warning">{unavailableCount} 条通知暂时无法查看，已保留未读。</Typography.Text> : null}
      {!loading && !error && details.length === 0 ? <Typography.Text type="secondary">暂无可查看的分润通知</Typography.Text> : null}
      <div className="dashboard-notification-detail-list">
        {details.map(({ notification, order, execution }) => {
          const recoveryRow = execution.detail_view.execution_rows.find((row) => row.category === "INBOUND");
          const inventoryEntryLabel = order.order_type === "HS" ? "回收入库时间" : "库存入库时间";
          return (
            <section key={notification.id} className="dashboard-notification-detail" aria-label={`订单 ${order.order_no}`}>
              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label="订单号">{order.order_no}</Descriptions.Item>
                <Descriptions.Item label="订单金额">{money(order.sale_amount)}</Descriptions.Item>
                <Descriptions.Item label="分润配置人">{notification.created_by || "-"}</Descriptions.Item>
                <Descriptions.Item label="通知时间">{formatDateTimeMinute(notification.created_at)}</Descriptions.Item>
                <Descriptions.Item label="库存号">{execution.account.stock_no || order.stock_no || "-"}</Descriptions.Item>
                <Descriptions.Item label={inventoryEntryLabel}>{formatDateTimeMinute(execution.account.inventory_entry_at)}</Descriptions.Item>
                <Descriptions.Item label="库存移出时间">{formatDateTimeMinute(execution.detail_view.lifecycle.removed_at)}</Descriptions.Item>
                <Descriptions.Item label="回收操作人">{recoveryRow?.operator || "-"}</Descriptions.Item>
              </Descriptions>
              <Typography.Paragraph type="secondary" className="dashboard-notification-detail__message">
                {notification.message}
              </Typography.Paragraph>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}

export function BusinessAlerts({ alerts, loading, onPendingProfitNotificationsClick, onProfitNotificationsRead }: { alerts: string[]; loading: boolean; onPendingProfitNotificationsClick?: () => void; onProfitNotificationsRead?: () => void }) {
  const [profitNotificationsOpen, setProfitNotificationsOpen] = useState(false);
  return (
    <section aria-label="我的消息" className="business-alerts--expanded">
      <Card className="glass" title="我的消息">
        {loading ? null : alerts.length > 0 ? (
          <List
            size="small"
            dataSource={alerts}
            renderItem={(item) => (
              <List.Item>
                {item.startsWith("分润待配置") ? (
                  <button type="button" className="business-alert__button" onClick={onPendingProfitNotificationsClick}>{item}</button>
                ) : item.startsWith("获得分润通知") ? (
                  <button type="button" className="business-alert__button" onClick={() => setProfitNotificationsOpen(true)}>{item}</button>
                ) : item}
              </List.Item>
            )}
          />
        ) : (
          <Typography.Text type="secondary">暂无异常事项</Typography.Text>
        )}
      </Card>
      <ProfitNotificationModal
        open={profitNotificationsOpen}
        onClose={() => setProfitNotificationsOpen(false)}
        onRead={onProfitNotificationsRead}
      />
    </section>
  );
}
