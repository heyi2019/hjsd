import { Button, Descriptions, Modal, Spin, Typography } from "antd";
import { useEffect, useState } from "react";
import { reportsApi } from "../../shared/api/reports.api";
import type { ProfitNotificationDetail } from "../../shared/api/notifications.api";
import type { CommissionOrderGroup } from "../../shared/api/types/reporting";
import type { NotificationItem } from "../../shared/api/types/common";
import { formatDateTimeMinute, money } from "../../shared/lib/format";
import { CommissionDetailsTable } from "../../operations/reports/CommissionDetailsTable";
import { OrderDetailDialog } from "../../business/shared/order_detail/OrderDetailDialog";

export function ProfitNotificationModal({ selected, summary, onClose, onPartyNavigate }: { selected: NotificationItem; summary?: ProfitNotificationDetail; onClose: () => void; onPartyNavigate?: (path: string) => void }) {
  const [result, setResult] = useState<{ id: number; loading: boolean; error: boolean; detail: CommissionOrderGroup | null }>({ id: selected.id, loading: true, error: false, detail: null });
  const [attempt, setAttempt] = useState(0);
  const [showOrderDetail, setShowOrderDetail] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setResult({ id: selected.id, loading: true, error: false, detail: null });
    void reportsApi.commission({ notification_id: selected.id }).then((report) => {
      if (!cancelled) setResult({ id: selected.id, loading: false, error: false, detail: report.order_groups[0] ?? null });
    }).catch(() => { if (!cancelled) setResult({ id: selected.id, loading: false, error: true, detail: null }); });
    return () => { cancelled = true; };
  }, [selected.id, attempt]);
  const loading = result.id !== selected.id || result.loading;
  const detail = result.id === selected.id ? result.detail : null;
  return (
    <Modal open title="订单分润通知详情" onCancel={onClose} footer={null} width={720} destroyOnHidden>
      {loading ? <div className="notifications-detail__loading"><Spin /></div> : !detail ? <div><Typography.Text type="warning">订单详情暂时无法查看。</Typography.Text>{result.error && <Button type="link" onClick={() => setAttempt((n) => n + 1)}>重试</Button>}</div> : (
        <section className="notifications-detail" aria-label={`订单 ${detail.order_no}`}>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="订单号">{detail.order_no}</Descriptions.Item>
            <Descriptions.Item label="可分配利润">{money(summary?.allocatable_profit)}</Descriptions.Item>
            <Descriptions.Item label="可见人员分润合计">{money(detail.personnel_profit_base)}</Descriptions.Item>
            <Descriptions.Item label="入库日期">{detail.inventory_date || "-"}</Descriptions.Item>
            <Descriptions.Item label="出库日期">{detail.outbound_date || "-"}</Descriptions.Item>
            {summary && <Descriptions.Item label="售出金额">{money(summary.sale_amount)}</Descriptions.Item>}
            {summary && <Descriptions.Item label="成本">{money(summary.cost_amount)}</Descriptions.Item>}
            <Descriptions.Item label="分润配置人">{selected.created_by || "-"}</Descriptions.Item>
            <Descriptions.Item label="通知时间">{formatDateTimeMinute(selected.created_at)}</Descriptions.Item>
          </Descriptions>
          <Typography.Title level={5}>分润明细</Typography.Title>
          <CommissionDetailsTable row={{ ...detail, orders: detail.orders.filter((item) => item.user_id != null) }} />
          <div className="notifications-detail__actions"><Button type="primary" onClick={() => setShowOrderDetail(true)}>查看订单详情</Button></div>
          {showOrderDetail && <OrderDetailDialog orderId={detail.order_id} onClose={() => setShowOrderDetail(false)} onPartyNavigate={onPartyNavigate} />}
        </section>
      )}
    </Modal>
  );
}
