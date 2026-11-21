import { Card, List, Modal, Spin, Tabs, Typography } from "antd";
import { formatDateTimeMinute, money } from "../../../shared/lib/format";
import { ProfitNotificationModal } from "./ProfitNotificationModal";
import { isProfitNotification, useWorkbenchMessages } from "./useWorkbenchMessages";
import "./messages.css";

export function BusinessAlerts(props: Parameters<typeof useWorkbenchMessages>[0]) {
  const { username, dataOwner, selected, setSelected, notifications, notificationDetails, notificationError, inventorySyncError, notificationLoading, category, setCategory, retryItem, setReload, retryInventory, hasMore, scrollRef, loadMore, openNotification, ordered } = useWorkbenchMessages(props);
  return (
    <section aria-label="我的消息" className="business-alerts--expanded">
      <Card className="glass" title="我的消息">
        <Tabs activeKey={category} onChange={(value) => setCategory(value as "latest" | "sale" | "inventory")} items={[{ key: "latest", label: "最新消息" }, { key: "sale", label: "售出消息" }, { key: "inventory", label: "库存消息" }]} />
        <div ref={scrollRef} className="business-alerts__scroll" onScroll={(event) => { const el = event.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) void loadMore(); }}>
        {inventorySyncError && category !== "sale" ? <div><Typography.Text type="warning">库存消息刷新失败。</Typography.Text> <button type="button" onClick={retryInventory}>重试</button></div> : null}
        {notificationError ? <div><Typography.Text type="warning">{notificationError}</Typography.Text> <button type="button" onClick={() => { if (retryItem) void openNotification(retryItem); else if (notifications.length) void loadMore(); else setReload((n) => n + 1); }}>重试</button></div> : null}
        {ordered.length ? (
          <List
            size="small"
            dataSource={ordered}
            renderItem={(item) => {
              const isProfit = isProfitNotification(item);
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
