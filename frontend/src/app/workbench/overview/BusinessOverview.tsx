import { StatRow } from "../../../shared/ui";

export function BusinessOverview({
  orderCount,
  inventoryCount,
  inventoryOverdueCount,
  installmentCount,
  overdueInstallmentCount,
  loading,
  allPeriods = false,
  personalOrders,
  personalCustomers,
  onPersonalOrdersClick,
  onPersonalCustomersClick,
  personalEarnings,
  onPersonalEarningsClick,
  onInventoryClick,
  onOrdersClick,
  onInstallmentsClick,
  onOverdueInstallmentsClick,
  onInventoryOverdueClick,
}: {
  orderCount: number | null;
  inventoryCount: number | null;
  inventoryOverdueCount: number | null;
  installmentCount: number | null;
  overdueInstallmentCount: number | null;
  loading: boolean;
  allPeriods?: boolean;
  personalOrders: number | null;
  personalCustomers: number | null;
  onPersonalOrdersClick?: () => void;
  onPersonalCustomersClick?: () => void;
  personalEarnings: string | null;
  onPersonalEarningsClick?: () => void;
  onInventoryClick?: () => void;
  onOrdersClick?: () => void;
  onInstallmentsClick?: () => void;
  onOverdueInstallmentsClick?: () => void;
  onInventoryOverdueClick?: () => void;
}) {
  const amount = (value: number | null) => loading ? null : value;
  const whenAvailable = (value: number | null, onClick?: () => void) => loading || value === null ? undefined : onClick;
  return (
    <section aria-label="我的业务总览" className="ui-stack">
      <StatRow className="ui-stat-row--overview" items={[
        { label: allPeriods ? "我的订单" : "我的当期订单", kind: "count", amount: loading || personalOrders === null ? null : String(personalOrders), hint: "入库 / 售出操作人", onClick: loading || personalOrders === null ? undefined : onPersonalOrdersClick, testId: "workbench-personal-orders" },
        { label: allPeriods ? "我的收益" : "我的当期收益", amount: loading ? null : personalEarnings, hint: allPeriods ? "全部 · 本人分润基数" : "当期 · 本人分润基数", onClick: loading || personalEarnings === null ? undefined : onPersonalEarningsClick, testId: "workbench-personal-earnings" },
        { label: "在库账号", kind: "count", amount: amount(inventoryCount), onClick: whenAvailable(inventoryCount, onInventoryClick), testId: "workbench-inventory" },
        { label: "订单总量", kind: "count", amount: amount(orderCount), onClick: loading || orderCount === null ? undefined : onOrdersClick, testId: "workbench-orders" },
        { label: allPeriods ? "我的客户数" : "我的当期客户数", kind: "count", amount: loading || personalCustomers === null ? null : String(personalCustomers), onClick: loading || personalCustomers === null ? undefined : onPersonalCustomersClick, testId: "workbench-personal-customers" },
        { label: "分期合约", kind: "count", amount: amount(installmentCount), onClick: whenAvailable(installmentCount, onInstallmentsClick), testId: "workbench-installments" },
        { label: "逾期合约", kind: "count", amount: amount(overdueInstallmentCount), hint: "已标记逾期的合约", tone: "warn", onClick: whenAvailable(overdueInstallmentCount, onOverdueInstallmentsClick), testId: "workbench-overdue-installments" },
        { label: "在库超期账号", kind: "count", amount: amount(inventoryOverdueCount), hint: "未售超过 30 天", tone: "warn", onClick: whenAvailable(inventoryOverdueCount, onInventoryOverdueClick), testId: "workbench-inventory-overdue" },
      ]} />
    </section>
  );
}
