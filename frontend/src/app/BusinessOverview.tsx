import { Card, List, Typography } from "antd";
import type { Order } from "../shared/api/catalog";
import { StatRow } from "../shared/ui";

export function BusinessOverview({
  orders,
  inventoryCount,
  inventoryAgingCount,
  inventoryOverdueCount,
  installmentCount,
  newProfitNotificationCount,
  overdueInstallmentCount,
  profitNotificationsEnabled = true,
  overdueInstallmentsEnabled = true,
  ordersError = false,
  loading,
}: {
  orders: Order[];
  inventoryCount: number | null;
  inventoryAgingCount: number | null;
  inventoryOverdueCount: number | null;
  installmentCount: number | null;
  newProfitNotificationCount: number | null;
  overdueInstallmentCount: number | null;
  profitNotificationsEnabled?: boolean;
  overdueInstallmentsEnabled?: boolean;
  ordersError?: boolean;
  loading: boolean;
}) {
  const amount = (value: number | null) => loading ? null : value;
  const alerts = [
    inventoryAgingCount && inventoryAgingCount > 0 ? `库存订单入库超过 7 天 ${inventoryAgingCount} 个` : null,
      profitNotificationsEnabled && newProfitNotificationCount && newProfitNotificationCount > 0 ? `新的分润通知 ${newProfitNotificationCount} 条` : null,
      overdueInstallmentsEnabled && overdueInstallmentCount && overdueInstallmentCount > 0 ? `逾期合约 ${overdueInstallmentCount} 个` : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <section aria-label="业务总览" className="ui-stack">
      <StatRow items={[
        { label: "在库账号", kind: "count", amount: amount(inventoryCount) },
        { label: "订单总量", kind: "count", amount: ordersError ? null : amount(orders.length) },
        { label: "完成订单量", kind: "count", amount: ordersError ? null : amount(orders.filter((order) => order.status === "COMPLETED").length) },
        { label: "分期合约", kind: "count", amount: amount(installmentCount) },
        { label: "逾期合约", kind: "count", amount: amount(overdueInstallmentCount), tone: "warn" },
        { label: "在库超期账号", kind: "count", amount: amount(inventoryOverdueCount), hint: "未售超过 30 天", tone: "warn" },
      ]} />
      <section aria-label="业务提醒">
        <Card className="glass" title="业务提醒">
          {loading ? null : alerts.length > 0 ? (
            <List
              size="small"
              dataSource={alerts}
              renderItem={(item) => <List.Item>{item}</List.Item>}
            />
          ) : (
            <Typography.Text type="secondary">暂无异常事项</Typography.Text>
          )}
        </Card>
      </section>
    </section>
  );
}
