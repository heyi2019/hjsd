/** 分销·提号业务页：提号订单独立展示，游戏账号只保留在订单文本快照中。 */
import { Card } from "antd";
import { useCallback, useEffect, useState } from "react";
import type { ColumnsType } from "antd/es/table";
import { ordersApi } from "../../shared/api/orders.api";
import type { Order } from "../../shared/api/types/orders";
import { normalizeError } from "../../shared/api/client";
import {
  DataTable,
  ErrorBanner,
  PageHeader,
  PermissionButton,
  StatusTag,
} from "../../shared/ui";
import { CreateBusinessModal } from "../CreateBusinessModal";

export function ThBusinessPanel() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await ordersApi.list();
      setOrders(result.filter((order) => order.order_type === "TH"));
      setLoadError(null);
    } catch (error) {
      setLoadError(normalizeError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<Order> = [
    { title: "订单号", dataIndex: "order_no" },
    { title: "成交日", dataIndex: "trade_date" },
    { title: "状态", dataIndex: "status", render: (value: string) => <StatusTag status={value} /> },
    { title: "备注", dataIndex: "note", render: (value: string | null) => value || "-" },
  ];

  return (
    <section className="ui-stack th-business-page">
      <PageHeader
        title="分销·提号"
        description="登记提号业务与供货方付款，游戏账号关联提号库存实体并保留订单轨迹。"
        actions={(
          <PermissionButton permission="order.create" type="primary" onClick={() => setCreateOpen(true)}>
            新建提号
          </PermissionButton>
        )}
      />
      <ErrorBanner error={loadError} onRetry={() => void load()} retrying={loading} />
      <Card className="glass" title="提号订单">
        <DataTable<Order>
          columns={columns}
          rows={orders}
          loading={loading}
          page={1}
          pageSize={10}
          total={orders.length}
          emptyText="暂无提号订单"
          onPageChange={() => undefined}
       />
      </Card>
      <CreateBusinessModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async () => {
          setCreateOpen(false);
          await load();
        }}
        initialOrderType="TH"
      />
    </section>
  );
}
