/** 系统提醒：查看未读通知、标记已读并同步返点逾期提醒（SYS-01-04）。 */
import { Card, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { notificationsApi, type NotificationItem } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { DataTable, ErrorBanner, PermissionButton, StatRow, StatusTag } from "../shared/ui";
import type { ColumnsType } from "antd/es/table";

export function NotificationsPanel() {
  const [rows, setRows] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const result = await notificationsApi.list({ limit: 200 });
      setRows(result.items); setUnread(result.unread_total); setError(null);
    } catch (err) { setError(normalizeError(err)); }
  }, []);
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
    { title: "提醒编号", dataIndex: "notification_no" },
    { title: "标题", dataIndex: "title" },
    { title: "内容", dataIndex: "message" },
    { title: "对象", render: (_v, row) => `${row.entity_type}:${row.entity_id}` },
    { title: "状态", render: (_v, row) => <StatusTag status={row.read_at ? "READ" : "UNREAD"} /> },
    { title: "操作", render: (_v, row) => row.read_at ? null : <PermissionButton permission="finance.read" size="small" onClick={() => void markRead(row)}>标记已读</PermissionButton> },
  ];
  return <section className="ui-stack">
    <ErrorBanner error={error} onRetry={() => void load()} />
    <StatRow items={[{ label: "提醒总数", kind: "count", amount: String(rows.length) }, { label: "未读提醒", kind: "count", amount: String(unread), tone: unread ? "warn" : "plain" }]} />
    <Card className="glass" title="系统提醒" extra={<PermissionButton permission="order.exception.approve" onClick={() => void syncOverdue()}>同步返点逾期提醒</PermissionButton>}>
      <DataTable<NotificationItem> columns={columns} rows={rows} page={1} pageSize={10} total={rows.length} emptyText="暂无系统提醒" onPageChange={() => undefined} />
    </Card>
  </section>;
}
