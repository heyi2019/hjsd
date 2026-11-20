import { Card, Descriptions, List, Modal, Pagination, Spin, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { notificationsApi, type ProfitNotificationDetail as ProfitDetail } from "../shared/api/misc.api";
import type { NotificationItem } from "../shared/api/types/common";
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
  allPeriods = false,
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
  allPeriods?: boolean;
  personalOrders?: number | null;
  personalCustomers?: number | null;
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
        ...(personalOrders !== undefined ? [{ label: allPeriods ? "我的订单" : "我的当期订单", kind: "count" as const, amount: loading || personalOrdersError || personalOrders === null ? null : String(personalOrders), hint: "入库 / 售出操作人", onClick: loading || personalOrdersError || personalOrders === null ? undefined : onPersonalOrdersClick, testId: "dashboard-personal-orders" }] : []),
        ...(personalEarnings !== undefined ? [{ label: allPeriods ? "我的收益" : "我的当期收益", amount: loading || personalEarningsError ? null : personalEarnings, hint: allPeriods ? "全部 · 本人分润基数" : "当期 · 本人分润基数", onClick: loading || personalEarningsError || personalEarnings === null ? undefined : onPersonalEarningsClick, testId: "dashboard-personal-earnings" }] : []),
        { label: "在库账号", kind: "count", amount: amount(inventoryCount), onClick: onInventoryClick, testId: "dashboard-inventory" },
        { label: "订单总量", kind: "count", amount: ordersError || !orderSummary ? null : amount(orderSummary.total_count), onClick: loading || ordersError || !orderSummary ? undefined : onOrdersClick, testId: "dashboard-orders" },
        ...(personalCustomers !== undefined ? [{ label: allPeriods ? "我的客户数" : "我的当期客户数", kind: "count" as const, amount: loading || ordersError || personalCustomers === null ? null : String(personalCustomers), onClick: loading || ordersError || personalCustomers === null ? undefined : onPersonalCustomersClick, testId: "dashboard-personal-customers" }] : []),
        { label: "分期合约", kind: "count", amount: amount(installmentCount), onClick: onInstallmentsClick, testId: "dashboard-installments" },
        { label: "逾期合约", kind: "count", amount: amount(overdueInstallmentCount), tone: "warn", onClick: onOverdueInstallmentsClick, testId: "dashboard-overdue-installments" },
        { label: "在库超期账号", kind: "count", amount: amount(inventoryOverdueCount), hint: "未售超过 30 天", tone: "warn", onClick: onInventoryOverdueClick, testId: "dashboard-inventory-overdue" },
      ]} />
    </section>
  );
}

async function settleInBatches<T, R>(items: T[], action: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let index = 0; index < items.length; index += 10) {
    results.push(...await Promise.allSettled(items.slice(index, index + 10).map(action)));
  }
  return results;
}

type ProfitNotificationDetail = {
  notification: NotificationItem;
  detail: ProfitDetail;
};
type NotificationPage = { items: NotificationItem[]; total: number; details?: ProfitNotificationDetail[]; unavailableCount?: number };

function ProfitNotificationModal({ open, onClose, onRead }: { open: boolean; onClose: () => void; onRead?: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<ProfitNotificationDetail[]>([]);
  const [unavailableCount, setUnavailableCount] = useState(0);
  const [readFailureCount, setReadFailureCount] = useState(0);
  const [detailPage, setDetailPage] = useState(1);
  const [total, setTotal] = useState(0);
  const onReadRef = useRef(onRead);
  const attemptedReads = useRef(new Set<number>());
  const pages = useRef<NotificationPage[]>([]);
  const generation = useRef(0);

  useEffect(() => {
    onReadRef.current = onRead;
  }, [onRead]);

  useEffect(() => {
    if (!open) return undefined;
    const currentGeneration = ++generation.current;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetails([]);
    setUnavailableCount(0);
    void (async () => {
        while (pages.current.length < detailPage) {
          const previous = pages.current[pages.current.length - 1];
          if (previous && previous.items.length < 10) break;
          const beforeId = previous?.items[previous.items.length - 1]?.id;
          const page = await notificationsApi.list({ limit: 10, unread_only: true, notification_type: "PROFIT_ALLOCATED", entity_type: "order", ...(beforeId ? { before_id: beforeId } : {}) });
          if (cancelled || currentGeneration !== generation.current) return;
          if (!page.items.length && page.total > 0) throw new Error("通知读取不完整，请重试");
          pages.current.push(page);
          if (pages.current.length === 1) setTotal(page.total);
          if (!page.items.length) break;
        }
        const page = pages.current[detailPage - 1];
        const items = page?.items ?? [];
        const loaded = page?.details || !items.length ? [] : await notificationsApi.profitDetails(items.map((notification) => notification.id));
        if (cancelled || currentGeneration !== generation.current) return;
        const byId = new Map(loaded.map((detail) => [detail.notification_id, detail]));
        const available = page?.details ?? items.flatMap((notification) => {
          const detail = byId.get(notification.id);
          return detail ? [{ notification, detail }] : [];
        });
        const unavailable = page?.unavailableCount ?? items.length - available.length;
        if (page) { page.details = available; page.unavailableCount = unavailable; }
        setDetails(available);
        setUnavailableCount(unavailable);
        setLoading(false);
        const visible = available.filter(({ notification }) => !attemptedReads.current.has(notification.id));
        for (const { notification } of visible) attemptedReads.current.add(notification.id);
        if (visible.length) {
          const results = await settleInBatches(visible, (item) => notificationsApi.markRead(item.notification.id));
          const failed = results.filter((result) => result.status === "rejected").length;
          if (!cancelled) setReadFailureCount((count) => count + failed);
          if (failed < results.length) onReadRef.current?.();
        }
      })()
      .catch((reason) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "分润通知详情加载失败");
        setLoading(false);
      });
    return () => {
      cancelled = true;
      generation.current += 1;
    };
  }, [open, detailPage]);

  return (
    <Modal open={open} title="订单分润通知详情" onCancel={onClose} footer={null} width={720} destroyOnHidden>
      {loading ? <div className="dashboard-notification-detail__loading"><Spin /></div> : null}
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {!loading && !error && unavailableCount > 0 ? <Typography.Text type="warning">{unavailableCount} 条通知暂时无法查看，已保留未读。</Typography.Text> : null}
      {!loading && !error && readFailureCount > 0 ? <Typography.Text type="warning">{readFailureCount} 条通知未能标为已读，请稍后重试。</Typography.Text> : null}
      {!loading && !error && details.length === 0 ? <Typography.Text type="secondary">暂无可查看的分润通知</Typography.Text> : null}
      <div className="dashboard-notification-detail-list">
        {details.map(({ notification, detail }) => {
          const inventoryEntryLabel = detail.order_type === "HS" ? "回收入库时间" : "库存入库时间";
          return (
            <section key={notification.id} className="dashboard-notification-detail" aria-label={`订单 ${detail.order_no}`}>
              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label="订单号">{detail.order_no}</Descriptions.Item>
                <Descriptions.Item label="订单金额">{money(detail.sale_amount)}</Descriptions.Item>
                <Descriptions.Item label="分润配置人">{notification.created_by || "-"}</Descriptions.Item>
                <Descriptions.Item label="通知时间">{formatDateTimeMinute(notification.created_at)}</Descriptions.Item>
                <Descriptions.Item label="库存号">{detail.stock_no || "-"}</Descriptions.Item>
                <Descriptions.Item label={inventoryEntryLabel}>{formatDateTimeMinute(detail.inventory_entry_at)}</Descriptions.Item>
                <Descriptions.Item label="库存移出时间">{formatDateTimeMinute(detail.removed_at)}</Descriptions.Item>
                <Descriptions.Item label="回收操作人">{detail.recovery_operator || "-"}</Descriptions.Item>
              </Descriptions>
              <Typography.Paragraph type="secondary" className="dashboard-notification-detail__message">
                {notification.message}
              </Typography.Paragraph>
            </section>
          );
        })}
      </div>
      {total > 10 ? <Pagination current={detailPage} pageSize={10} total={total} showSizeChanger={false} onChange={setDetailPage} /> : null}
    </Modal>
  );
}

export function BusinessAlerts({ alerts, loading, error = false, onPendingProfitNotificationsClick, onProfitNotificationsRead }: { alerts: string[]; loading: boolean; error?: boolean; onPendingProfitNotificationsClick?: () => void; onProfitNotificationsRead?: () => void }) {
  const [profitNotificationsOpen, setProfitNotificationsOpen] = useState(false);
  return (
    <section aria-label="我的消息" className="business-alerts--expanded">
      <Card className="glass" title="我的消息">
        {loading ? null : error ? <Typography.Text type="warning">消息加载失败，请重新加载。</Typography.Text> : alerts.length > 0 ? (
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
      {profitNotificationsOpen && <ProfitNotificationModal
        open
        onClose={() => setProfitNotificationsOpen(false)}
        onRead={onProfitNotificationsRead}
      />}
    </section>
  );
}
