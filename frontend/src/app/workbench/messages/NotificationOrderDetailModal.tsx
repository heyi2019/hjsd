import { Button, Modal, Spin, Typography } from "antd";
import { useEffect, useState } from "react";
import { OrderDetail } from "../../../business/OrderDetailView/OrderDetail";
import { ordersApi } from "../../../shared/api/orders.api";
import { employeesApi } from "../../../shared/api/org.api";
import type { AccountExecutionDetail } from "../../../shared/api/types/account-execution";
import type { EmployeeOption } from "../../../shared/api/types/org";

export function NotificationOrderDetailModal({ orderId, onClose }: { orderId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<AccountExecutionDetail | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setLoading(true);
    setError(false);
    void ordersApi.executionDetail(orderId, { imagePreviews: true }).then((result) => {
      if (active) setDetail(result);
    }).catch(() => {
      if (active) setError(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    void employeesApi.list().then((result) => {
      if (active) setEmployees(result);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [orderId, attempt]);

  return (
    <Modal open title="订单详情" onCancel={onClose} footer={null} width={1200} styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }} destroyOnHidden>
      {loading ? <div className="dashboard-notification-detail__loading"><Spin /></div> : error || !detail ? (
        <div><Typography.Text type="warning">订单详情加载失败，可能没有查看权限。</Typography.Text><Button type="link" onClick={() => setAttempt((n) => n + 1)}>重试</Button></div>
      ) : <OrderDetail row={detail.account} detail={detail} contextOrderId={orderId} loading={false} employees={employees} />}
    </Modal>
  );
}
