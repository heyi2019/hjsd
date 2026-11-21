import { Card, Descriptions, List, Modal, Spin, Tabs, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { notificationsApi, type ProfitNotificationDetail as ProfitDetail } from "../shared/api/misc.api";
import type { NotificationItem } from "../shared/api/types/common";
import { formatDateTimeMinute, money } from "../shared/lib/format";
import { StatRow } from "../shared/ui";
import { useSession } from "../shared/state/session";

export function BusinessOverview({
  orderCount,
  inventoryCount,
  inventoryOverdueCount,
  installmentCount,
  overdueInstallmentCount,
  loading,
  allPeriods = false,
  personalOrders,
  personalCustomers,
  onPersonalOrdersClick,
  onPersonalCustomersClick,
  personalEarnings,
  onPersonalEarningsClick,
  onInventoryClick,
  onOrdersClick,
  onInstallmentsClick,
  onOverdueInstallmentsClick,
  onInventoryOverdueClick,
}: {
  orderCount: number | null;
  inventoryCount: number | null;
  inventoryOverdueCount: number | null;
  installmentCount: number | null;
  overdueInstallmentCount: number | null;
  loading: boolean;
  allPeriods?: boolean;
  personalOrders: number | null;
  personalCustomers: number | null;
  onPersonalOrdersClick?: () => void;
  onPersonalCustomersClick?: () => void;
  personalEarnings: string | null;
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
        { label: allPeriods ? "我的订单" : "我的当期订单", kind: "count", amount: loading || personalOrders === null ? null : String(personalOrders), hint: "入库 / 售出操作人", onClick: loading || personalOrders === null ? undefined : onPersonalOrdersClick, testId: "dashboard-personal-orders" },
        { label: allPeriods ? "我的收益" : "我的当期收益", amount: loading ? null : personalEarnings, hint: allPeriods ? "全部 · 本人分润基数" : "当期 · 本人分润基数", onClick: loading || personalEarnings === null ? undefined : onPersonalEarningsClick, testId: "dashboard-personal-earnings" },
        { label: "在库账号", kind: "count", amount: amount(inventoryCount), onClick: onInventoryClick, testId: "dashboard-inventory" },
        { label: "订单总量", kind: "count", amount: amount(orderCount), onClick: loading || orderCount === null ? undefined : onOrdersClick, testId: "dashboard-orders" },
        { label: allPeriods ? "我的客户数" : "我的当期客户数", kind: "count", amount: loading || personalCustomers === null ? null : String(personalCustomers), onClick: loading || personalCustomers === null ? undefined : onPersonalCustomersClick, testId: "dashboard-personal-customers" },
        { label: "分期合约", kind: "count", amount: amount(installmentCount), onClick: onInstallmentsClick, testId: "dashboard-installments" },
        { label: "逾期合约", kind: "count", amount: amount(overdueInstallmentCount), tone: "warn", onClick: onOverdueInstallmentsClick, testId: "dashboard-overdue-installments" },
        { label: "在库超期账号", kind: "count", amount: amount(inventoryOverdueCount), hint: "未售超过 30 天", tone: "warn", onClick: onInventoryOverdueClick, testId: "dashboard-inventory-overdue" },
      ]} />
    </section>
  );
}

function ProfitNotificationModal({ selected, onClose }: { selected: NotificationItem; onClose: () => void }) {
  const [detail, setDetail] = useState<ProfitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void notificationsApi.profitDetails([selected.id]).then((items) => {
      if (!cancelled) setDetail(items.find((item) => item.notification_id === selected.id) ?? null);
    }).catch(() => { if (!cancelled) setError(true); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selected.id]);
  return (
    <Modal open title="订单分润通知详情" onCancel={onClose} footer={null} width={720} destroyOnHidden>
      {loading ? <div className="dashboard-notification-detail__loading"><Spin /></div> : error || !detail ? <Typography.Text type="warning">订单详情暂时无法查看。</Typography.Text> : (
        <section className="dashboard-notification-detail" aria-label={`订单 ${detail.order_no}`}>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="订单号">{detail.order_no}</Descriptions.Item>
            <Descriptions.Item label="订单金额">{money(detail.sale_amount)}</Descriptions.Item>
            <Descriptions.Item label="分润配置人">{selected.created_by || "-"}</Descriptions.Item>
            <Descriptions.Item label="通知时间">{formatDateTimeMinute(selected.created_at)}</Descriptions.Item>
            <Descriptions.Item label="库存号">{detail.stock_no || "-"}</Descriptions.Item>
            <Descriptions.Item label={detail.order_type === "HS" ? "回收入库时间" : "库存入库时间"}>{formatDateTimeMinute(detail.inventory_entry_at)}</Descriptions.Item>
            <Descriptions.Item label="库存移出时间">{formatDateTimeMinute(detail.removed_at)}</Descriptions.Item>
            <Descriptions.Item label="回收操作人">{detail.recovery_operator || "-"}</Descriptions.Item>
          </Descriptions>
          <Typography.Paragraph type="secondary" className="dashboard-notification-detail__message">{selected.message}</Typography.Paragraph>
        </section>
      )}
    </Modal>
  );
}

export function BusinessAlerts({ onPendingProfitNotificationsClick, onProfitNotificationsRead, active = true }: { onPendingProfitNotificationsClick?: (id?: number) => void; onProfitNotificationsRead?: () => void; active?: boolean }) {
  const { username } = useSession();
  const [dataOwner, setDataOwner] = useState(username);
  const [selected, setSelected] = useState<NotificationItem | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationDetails, setNotificationDetails] = useState<Record<number, ProfitDetail>>({});
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [inventorySyncError, setInventorySyncError] = useState(false);
  const [notificationLoading, setNotificationLoading] = useState(true);
  const [category, setCategory] = useState<"latest" | "sale" | "inventory">("latest");
  const [retryItem, setRetryItem] = useState<NotificationItem | null>(null);
  const [reload, setReload] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const cursor = useRef<{ phase: "unread" | "read" | "done"; before?: number; beforeTime?: string; generation: number; loading: boolean }>({ phase: "unread", generation: 0, loading: false });
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = useRef(new Set<number>());
  const loadMore = async () => {
    const state = cursor.current;
    if (!active || state.loading || state.phase === "done") return;
    state.loading = true;
    const generation = state.generation;
    setNotificationLoading(true);
    try {
      let phase = state.phase;
      let before = state.before;
      const categoryParam = category === "latest" ? {} : { category };
      let page = await notificationsApi.list({ limit: 10, sort_by_time: true, ...categoryParam, ...(phase === "unread" ? { unread_only: true } : { read_only: true }), ...(before ? { before_id: before, before_created_at: state.beforeTime } : {}) });
      if (cursor.current.generation !== generation) return;
      if (phase === "unread" && !page.items.length) {
        if (category === "latest") { state.phase = "done"; setHasMore(false); return; }
        phase = "read";
        before = undefined;
        page = await notificationsApi.list({ limit: 10, sort_by_time: true, read_only: true, ...categoryParam });
        if (cursor.current.generation !== generation) return;
      }
      const ids = page.items.filter((item) => item.entity_type === "order" && ["PROFIT_PENDING", "PROFIT_ALLOCATED"].includes(item.notification_type ?? "")).map((item) => item.id);
      let details: ProfitDetail[] = [];
      if (ids.length) {
        try { details = await notificationsApi.profitDetails(ids); } catch { /* 保留消息并显示详情不可用 */ }
      }
      if (cursor.current.generation !== generation) return;
      setNotificationDetails((current) => ({ ...current, ...Object.fromEntries(details.map((item) => [item.notification_id, item])) }));
      setNotifications((current) => [...current, ...page.items.filter((item) => !current.some((old) => old.id === item.id))]);
      if (page.items.length < 10) {
        state.phase = phase === "unread" && category !== "latest" ? "read" : "done";
        state.before = undefined;
        state.beforeTime = undefined;
      } else {
        const last = page.items[page.items.length - 1];
        if (!last.created_at || (before === last.id && state.beforeTime === last.created_at)) throw new Error("消息分页游标异常");
        state.phase = phase;
        state.before = last.id;
        state.beforeTime = last.created_at;
      }
      setHasMore(state.phase !== "done");
      setNotificationError(null);
    } catch {
      if (cursor.current.generation === generation) setNotificationError("消息加载失败，请重试。");
    } finally {
      if (cursor.current.generation === generation) { state.loading = false; setNotificationLoading(false); }
    }
  };
  useEffect(() => {
    if (!active) return;
    cursor.current = { phase: "unread", generation: cursor.current.generation + 1, loading: true };
    const generation = cursor.current.generation;
    setDataOwner(username);
    setSelected(null);
    setNotifications([]);
    setNotificationDetails({});
    setNotificationError(null);
    setRetryItem(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setHasMore(true);
    setInventorySyncError(false);
    setNotificationLoading(true);
    void (async () => {
      try { await notificationsApi.syncInventory(); } catch { if (cursor.current.generation === generation) setInventorySyncError(true); }
      if (active && cursor.current.generation === generation) { cursor.current.loading = false; void loadMore(); }
    })();
    return () => { cursor.current.generation += 1; };
    // 加载由 active 和用户重试触发；滚动时使用当前游标。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reload, category, username]);
  useEffect(() => {
    const el = scrollRef.current;
    if (active && el && !notificationLoading && hasMore && !notificationError && el.scrollHeight <= el.clientHeight + 1) void loadMore();
    // 只有列表不足以滚动时自动补页。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, notifications.length, notificationLoading, hasMore, notificationError]);

  const openNotification = async (item: NotificationItem) => {
    if (busy.current.has(item.id)) return;
    busy.current.add(item.id);
    const generation = cursor.current.generation;
    try {
      if (!item.read_at) {
        const result = await notificationsApi.markReadBatch([item.id]);
        if (cursor.current.generation !== generation) return;
        if (!result.read_ids.includes(item.id)) throw new Error("标记已读失败，请重试。");
        setNotifications((current) => current.map((entry) => entry.id === item.id ? { ...entry, read_at: new Date().toISOString() } : entry));
        onProfitNotificationsRead?.();
      }
      setNotificationError(null);
      setRetryItem(null);
      if (item.notification_type === "PROFIT_PENDING" && item.entity_type === "order") onPendingProfitNotificationsClick?.(item.id);
      else setSelected(item);
    } catch {
      if (cursor.current.generation === generation) { setNotificationError("标记已读失败，请重试。"); setRetryItem(item); }
    } finally {
      busy.current.delete(item.id);
    }
  };
  const ordered = dataOwner === username ? notifications.filter((item) => category !== "latest" || !item.read_at).sort((a, b) => Number(Boolean(a.read_at)) - Number(Boolean(b.read_at)) || (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id) : [];
  return (
    <section aria-label="我的消息" className="business-alerts--expanded">
      <Card className="glass" title="我的消息">
        <Tabs activeKey={category} onChange={(value) => setCategory(value as "latest" | "sale" | "inventory")} items={[{ key: "latest", label: "最新消息" }, { key: "sale", label: "售出消息" }, { key: "inventory", label: "库存消息" }]} />
        <div ref={scrollRef} className="business-alerts__scroll" onScroll={(event) => { const el = event.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) void loadMore(); }}>
        {inventorySyncError && category !== "sale" ? <div><Typography.Text type="warning">库存消息刷新失败。</Typography.Text> <button type="button" onClick={() => setReload((n) => n + 1)}>重试</button></div> : null}
        {notificationError ? <div><Typography.Text type="warning">{notificationError}</Typography.Text> <button type="button" onClick={() => { if (retryItem) void openNotification(retryItem); else if (notifications.length) void loadMore(); else setReload((n) => n + 1); }}>重试</button></div> : null}
        {ordered.length ? (
          <List
            size="small"
            dataSource={ordered}
            renderItem={(item) => {
              const isProfit = item.entity_type === "order" && ["PROFIT_PENDING", "PROFIT_ALLOCATED"].includes(item.notification_type ?? "");
              const detail = notificationDetails[item.id];
              return (
                <List.Item>
                  <button type="button" className="business-alert__button business-alert__message" onClick={() => void openNotification(item)}>
                    <span className="business-alert__title" title={item.message}>{item.message}</span>
                    <span className={item.read_at ? "business-alert__read" : "business-alert__unread"}>{item.read_at ? "已读" : "未读"}</span>
                    <span className="business-alert__details">{isProfit ? (detail
                      ? `成本 ${money(detail.cost_amount)} · 售出 ${money(detail.sale_amount)} · ${item.notification_type === "PROFIT_PENDING" ? "待分配利润" : "可分配利润"} ${money(detail.allocatable_profit)}`
                      : "订单详情暂不可用") : ""}</span>
                    <span className="business-alert__time">通知时间 {formatDateTimeMinute(item.created_at)}</span>
                  </button>
                </List.Item>
              );
            }}
          />
        ) : (
          notificationError || notificationLoading || hasMore ? null : <Typography.Text type="secondary">暂无消息</Typography.Text>
        )}
        {notificationLoading ? <Spin size="small" /> : hasMore && !notificationError ? <button type="button" className="business-alert__button" onClick={() => void loadMore()}>加载更多</button> : null}
        </div>
      </Card>
      {dataOwner === username && selected?.notification_type === "PROFIT_ALLOCATED" && <ProfitNotificationModal
        selected={selected}
        onClose={() => setSelected(null)}
      />}
      {dataOwner === username && selected && selected.notification_type !== "PROFIT_ALLOCATED" && <Modal open title={selected.title} onCancel={() => setSelected(null)} footer={null}>{selected.message}</Modal>}
    </section>
  );
}
