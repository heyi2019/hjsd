import { Card, List, Typography } from "antd";
import { StatRow } from "../shared/ui";

export function BusinessOverview({
  orderSummary,
  inventoryCount,
  inventoryOverdueCount,
  installmentCount,
  overdueInstallmentCount,
  ordersError = false,
  loading,
  personalOrders,
  personalOrdersError = false,
  onPersonalOrdersClick,
  personalEarnings,
  personalEarningsError = false,
  onPersonalEarningsClick,
}: {
  orderSummary: { total_count: number; completed_count: number } | null;
  inventoryCount: number | null;
  inventoryAgingCount: number | null;
  inventoryOverdueCount: number | null;
  installmentCount: number | null;
  overdueInstallmentCount: number | null;
  profitNotificationsEnabled?: boolean;
  overdueInstallmentsEnabled?: boolean;
  ordersError?: boolean;
  loading: boolean;
  personalOrders?: number;
  personalOrdersError?: boolean;
  onPersonalOrdersClick?: () => void;
  personalEarnings?: string | null;
  personalEarningsError?: boolean;
  onPersonalEarningsClick?: () => void;
}) {
  const amount = (value: number | null) => loading ? null : value;
  return (
    <section aria-label="我的业务总览" className="ui-stack">
      <StatRow className="ui-stat-row--overview" items={[
        ...(personalOrders !== undefined ? [{ label: "我的当期订单", kind: "count" as const, amount: personalOrdersError ? null : String(personalOrders), hint: "创建 / 售出订单", onClick: onPersonalOrdersClick, testId: "dashboard-personal-orders" }] : []),
        ...(personalEarnings !== undefined ? [{ label: "我的当期收益", amount: personalEarningsError ? null : personalEarnings, hint: "本月至今 · 本人应付分润", onClick: onPersonalEarningsClick, testId: "dashboard-personal-earnings" }] : []),
        { label: "在库账号", kind: "count", amount: amount(inventoryCount) },
        { label: "订单总量", kind: "count", amount: ordersError || !orderSummary ? null : amount(orderSummary.total_count) },
        { label: "完成订单量", kind: "count", amount: ordersError || !orderSummary ? null : amount(orderSummary.completed_count) },
        { label: "分期合约", kind: "count", amount: amount(installmentCount) },
        { label: "逾期合约", kind: "count", amount: amount(overdueInstallmentCount), tone: "warn" },
        { label: "在库超期账号", kind: "count", amount: amount(inventoryOverdueCount), hint: "未售超过 30 天", tone: "warn" },
      ]} />
    </section>
  );
}

export function BusinessAlerts({ alerts, loading }: { alerts: string[]; loading: boolean }) {
  return (
    <section aria-label="我的消息" className="business-alerts--expanded">
      <Card className="glass" title="我的消息">
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
  );
}
