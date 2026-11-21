import { Descriptions, Modal, Spin, Typography } from "antd";
import { useEffect, useState } from "react";
import { notificationsApi, type ProfitNotificationDetail as ProfitDetail } from "../../../shared/api/notifications.api";
import type { NotificationItem } from "../../../shared/api/types/common";
import { formatDateTimeMinute, money } from "../../../shared/lib/format";

export function ProfitNotificationModal({ selected, onClose }: { selected: NotificationItem; onClose: () => void }) {
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
