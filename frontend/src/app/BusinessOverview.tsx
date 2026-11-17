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
  personalCustomers,
  personalOrdersError = false,
  onPersonalOrdersClick,
  onPersonalCustomersClick,
  personalEarnings,
  personalEarningsError = false,
  onPersonalEarningsClick,
  onInventoryClick,
  onOrdersClick,
  onInstallmentsClick,
  onOverdueInstallmentsClick,
  onInventoryOverdueClick,
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
  personalCustomers?: number;
  personalOrdersError?: boolean;
  onPersonalOrdersClick?: () => void;
  onPersonalCustomersClick?: () => void;
  personalEarnings?: string | null;
  personalEarningsError?: boolean;
  onPersonalEarningsClick?: () => void;
  onInventoryClick?: () => void;
  onOrdersClick?: () => void;
  onInstallmentsClick?: () => void;
  onOverdueInstallmentsClick?: () => void;
  onInventoryOverdueClick?: () => void;
}) {
  const amount = (value: number | null) => loading ? null : value;
  return (
    <section aria-label="我的业务总览" className="ui-stack">
      <StatRow className="ui-stat-row--overview" items={[
        ...(personalOrders !== undefined ? [{ label: "我的当期订单", kind: "count" as const, amount: personalOrdersError ? null : String(personalOrders), hint: "入库 / 售出操作人", onClick: onPersonalOrdersClick, testId: "dashboard-personal-orders" }] : []),
        ...(personalEarnings !== undefined ? [{ label: "我的当期收益", amount: personalEarningsError ? null : personalEarnings, hint: "当期 · 本人分润基数", onClick: onPersonalEarningsClick, testId: "dashboard-personal-earnings" }] : []),
        { label: "在库账号", kind: "count", amount: amount(inventoryCount), onClick: onInventoryClick, testId: "dashboard-inventory" },
        { label: "订单总量", kind: "count", amount: ordersError || !orderSummary ? null : amount(orderSummary.total_count), onClick: onOrdersClick, testId: "dashboard-orders" },
        ...(personalCustomers !== undefined ? [{ label: "我的当期客户数", kind: "count" as const, amount: ordersError ? null : String(personalCustomers), onClick: onPersonalCustomersClick, testId: "dashboard-personal-customers" }] : []),
        { label: "分期合约", kind: "count", amount: amount(installmentCount), onClick: onInstallmentsClick, testId: "dashboard-installments" },
        { label: "逾期合约", kind: "count", amount: amount(overdueInstallmentCount), tone: "warn", onClick: onOverdueInstallmentsClick, testId: "dashboard-overdue-installments" },
        { label: "在库超期账号", kind: "count", amount: amount(inventoryOverdueCount), hint: "未售超过 30 天", tone: "warn", onClick: onInventoryOverdueClick, testId: "dashboard-inventory-overdue" },
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
