import { Card, List, Modal, Spin, Tabs, Typography } from "antd";
import type { NotificationCategory } from "../../../shared/api/notifications.api";
import { formatDateTimeMinute, money } from "../../../shared/lib/format";
import { ProfitNotificationModal } from "./ProfitNotificationModal";
import { isProfitNotification, useNotifications } from "./useNotifications";
import "./notifications.css";

export function Notifications(props: Parameters<typeof useNotifications>[0] & { onPartyNavigate?: (path: string) => void }) {
  const { username, dataOwner, selected, setSelected, notifications, notificationDetails, pendingDetails, notificationError, reminderSyncError, notificationLoading, category, setCategory, retryItem, setReload, retryReminders, failedDetails, detailsRetrying, retryDetails, hasMore, scrollRef, loadMore, refreshSyncedReminders, openNotification, ordered } = useNotifications(props);
  return (
    <section aria-label="我的消息" className="notifications--expanded">
      <Card className="glass" title="我的消息">
        <Tabs activeKey={category} onChange={(value) => setCategory(value as NotificationCategory)} items={[{ key: "latest", label: "最新消息" }, { key: "sale", label: "售出消息" }, { key: "inventory", label: "库存消息" }, { key: "contract", label: "合约消息" }]} />
        <div ref={scrollRef} className="notifications__scroll" onScroll={(event) => { const el = event.currentTarget; if (el.scrollTop <= 0 && refreshSyncedReminders()) return; if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) void loadMore(); }}>
        {reminderSyncError && category !== "sale" ? <div><Typography.Text type="warning">提醒同步失败。</Typography.Text> <button type="button" onClick={retryReminders}>重试</button></div> : null}
        {notificationError ? <div><Typography.Text type="warning">{notificationError}</Typography.Text> <button type="button" onClick={() => { if (retryItem) void openNotification(retryItem); else if (notifications.length) void loadMore(); else setReload((n) => n + 1); }}>重试</button></div> : null}
        {failedDetails.length ? <div><Typography.Text type="warning">分润详情加载失败。</Typography.Text> <button type="button" disabled={detailsRetrying} onClick={() => void retryDetails()}>重试分润详情</button></div> : null}
        {ordered.length ? (
          <List
            size="small"
            rowKey="id"
            dataSource={ordered}
            renderItem={(item) => {
              const isProfit = isProfitNotification(item);
              const detail = notificationDetails[item.id];
              return (
                <List.Item>
                  <button type="button" className="notification__button notification__message" onClick={() => void openNotification(item)}>
                    <span className="notification__title" title={item.message}>{item.message}</span>
                    <span className={item.read_at ? "notification__read" : "notification__unread"}>{item.read_at ? "已读" : "未读"}</span>
                    <span className="notification__details">{isProfit ? (detail
                      ? `成本 ${money(detail.cost_amount)} · 售出 ${money(detail.sale_amount)} · ${item.notification_type === "PROFIT_PENDING" ? "待分配利润" : "可分配利润"} ${money(detail.allocatable_profit)}`
                      : pendingDetails.includes(item.id) ? "订单详情加载中" : "订单详情暂不可用") : ""}</span>
                    <span className="notification__time">通知时间 {formatDateTimeMinute(item.created_at)}</span>
                  </button>
                </List.Item>
              );
            }}
          />
        ) : (
          notificationError || notificationLoading || hasMore ? null : <Typography.Text type="secondary">暂无消息</Typography.Text>
        )}
        {notificationLoading ? <Spin size="small" /> : null}
        </div>
      </Card>
      {props.active !== false && dataOwner === username && selected?.notification_type === "PROFIT_ALLOCATED" && <ProfitNotificationModal
        selected={selected}
        summary={notificationDetails[selected.id]}
        onClose={() => setSelected(null)}
        onPartyNavigate={props.onPartyNavigate ? (path) => { setSelected(null); props.onPartyNavigate?.(path); } : undefined}
      />}
      {props.active !== false && dataOwner === username && selected && selected.notification_type !== "PROFIT_ALLOCATED" && <Modal open title={selected.title} onCancel={() => setSelected(null)} footer={null}>{selected.message}</Modal>}
    </section>
  );
}
