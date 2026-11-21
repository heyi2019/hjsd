import { Button, Descriptions, Modal, Spin, Table, Typography } from "antd";
import { useEffect, useState } from "react";
import { notificationsApi, type ProfitNotificationDetail as ProfitDetail } from "../../../shared/api/notifications.api";
import type { NotificationItem } from "../../../shared/api/types/common";
import { formatDateTimeMinute, money } from "../../../shared/lib/format";

export function ProfitNotificationModal({ selected, onClose }: { selected: NotificationItem; onClose: () => void }) {
  const [result, setResult] = useState<{ id: number; loading: boolean; error: boolean; detail: ProfitDetail | null }>({ id: selected.id, loading: true, error: false, detail: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setResult({ id: selected.id, loading: true, error: false, detail: null });
    void notificationsApi.profitDetails([selected.id]).then((items) => {
      if (!cancelled) setResult({ id: selected.id, loading: false, error: false, detail: items.find((item) => item.notification_id === selected.id) ?? null });
    }).catch(() => { if (!cancelled) setResult({ id: selected.id, loading: false, error: true, detail: null }); });
    return () => { cancelled = true; };
  }, [selected.id, attempt]);
  const loading = result.id !== selected.id || result.loading;
  const detail = result.id === selected.id ? result.detail : null;
  return (
    <Modal open title="订单分润通知详情" onCancel={onClose} footer={null} width={720} destroyOnHidden>
      {loading ? <div className="dashboard-notification-detail__loading"><Spin /></div> : !detail ? <div><Typography.Text type="warning">订单详情暂时无法查看。</Typography.Text>{result.error && <Button type="link" onClick={() => setAttempt((n) => n + 1)}>重试</Button>}</div> : (
        <section className="dashboard-notification-detail" aria-label={`订单 ${detail.order_no}`}>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="订单号">{detail.order_no}</Descriptions.Item>
            <Descriptions.Item label="售出金额">{money(detail.sale_amount)}</Descriptions.Item>
            <Descriptions.Item label="分润配置人">{selected.created_by || "-"}</Descriptions.Item>
            <Descriptions.Item label="通知时间">{formatDateTimeMinute(selected.created_at)}</Descriptions.Item>
            <Descriptions.Item label="库存号">{detail.stock_no || "-"}</Descriptions.Item>
            <Descriptions.Item label={detail.order_type === "HS" ? "回收入库时间" : "库存入库时间"}>{formatDateTimeMinute(detail.inventory_entry_at)}</Descriptions.Item>
            <Descriptions.Item label="售出日期">{detail.sold_at?.slice(0, 10) || "-"}</Descriptions.Item>
            <Descriptions.Item label={detail.order_type === "HS" ? "回收操作人" : detail.order_type === "TH" ? "提号操作人" : "入库操作人"}>{detail.inventory_operator || "-"}</Descriptions.Item>
            <Descriptions.Item label="成本">{money(detail.cost_amount)}</Descriptions.Item>
            <Descriptions.Item label="订单利润">{money(detail.order_profit)}</Descriptions.Item>
          </Descriptions>
          <Typography.Title level={5}>分润明细</Typography.Title>
          <Table size="small" pagination={false} rowKey="id" scroll={{ x: 480 }} dataSource={detail.allocations} locale={{ emptyText: "暂无分润明细" }} columns={[
            { title: "归属", dataIndex: "allocation_type", render: (type: string | null) => ({ BUY: detail.order_type === "TH" ? "提号" : "买号", SELL: "售出", OPERATION: "运营", COMPANY: "公司" } as Record<string, string>)[type || ""] || "人员" },
            { title: "人员", dataIndex: "user_name" },
            { title: "比例", render: (_: unknown, row) => Number(row.rate) === 0 && Number(row.amount) !== 0 ? "按金额" : `${row.rate}%` },
            { title: "分润基数", dataIndex: "amount", render: (amount: string) => money(amount) },
          ]} />
          <Typography.Paragraph type="secondary" className="dashboard-notification-detail__message">{selected.message}</Typography.Paragraph>
        </section>
      )}
    </Modal>
  );
}
