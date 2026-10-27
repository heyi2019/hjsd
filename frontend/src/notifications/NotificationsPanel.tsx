/** 系统提醒：查看未读通知、标记已读并同步返点逾期提醒（SYS-01-04）。 */
import { Card, Checkbox, Space, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { notificationsApi, type NotificationItem } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { ENTITY_TYPE_LABEL } from "../shared/lib/labels";
import { DataTable, ErrorBanner, PermissionButton, StatRow, StatusTag } from "../shared/ui";
import type { ColumnsType } from "antd/es/table";

export function NotificationsPanel() {
  const [rows, setRows] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const result = await notificationsApi.list({ limit: 200, unread_only: unreadOnly });
      setRows(result.items); setUnread(result.unread_total); setError(null);
    } catch (err) { setError(normalizeError(err)); }
  }, [unreadOnly]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const markRead = async (row: NotificationItem) => {
    try { await notificationsApi.markRead(row.id); message.success("提醒已标记为已读"); await load(); }
    catch (err) { setError(normalizeError(err)); }
  };
  const syncOverdue = async () => {
    try { const result = await notificationsApi.syncOverdueRebates(); message.success(`逾期返点提醒已同步，新增 ${result.created} 条`); await load(); }
    catch (err) { setError(normalizeError(err)); }
  };
  const columns: ColumnsType<NotificationItem> = [
    { title: "提醒编号", dataIndex: "notification_no", className: "ui-col-md-up", onCell: () => ({ className: "ui-col-md-up" }) },
    { title: "标题", dataIndex: "title" },
    { title: "内容", dataIndex: "message" },
    { title: "对象", render: (_v, row) => `${ENTITY_TYPE_LABEL[row.entity_type] ?? row.entity_type} ${row.entity_id}`, className: "ui-col-md-up", onCell: () => ({ className: "ui-col-md-up" }) },
    { title: "状态", render: (_v, row) => <StatusTag status={row.read_at ? "READ" : "UNREAD"} /> },
    { title: "操作", render: (_v, row) => row.read_at ? null : <PermissionButton permission="finance.read" size="small" onClick={() => void markRead(row)}>标记已读</PermissionButton> },
  ];
  return <section className="ui-stack">
    <ErrorBanner error={error} onRetry={() => void load()} />
    <StatRow items={[{ label: "未读提醒", kind: "count", amount: String(unread), tone: unread ? "warn" : "plain" }, { label: unreadOnly ? "未读列表" : "提醒总数", kind: "count", amount: String(rows.length) }]} />
    <Card
      className="glass"
      title="系统提醒"
      extra={<Space wrap><Checkbox checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)}>仅看未读</Checkbox><PermissionButton permission="order.exception.approve" onClick={() => void syncOverdue()}>同步返点逾期提醒</PermissionButton></Space>}
    >
      <DataTable<NotificationItem> columns={columns} rows={rows} page={1} pageSize={10} total={rows.length} emptyText={unreadOnly ? "暂无未读提醒" : "暂无系统提醒"} onPageChange={() => undefined}/>
    </Card>
  </section>;
}
