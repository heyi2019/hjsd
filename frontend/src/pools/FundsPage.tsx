/** 资金中心：总览 / 资金明细 / 工作室运营 / 对账 / 押金。
 *  逻辑层见 useFundsPageController；视图层拆为 FundsPage.tabs 与 FundsPage.modals。 */
import { Tabs } from "antd";
import { ErrorBanner } from "../shared/ui";
import { StudioExpensePanel } from "./StudioExpensePanel";
import { useFundsPageController } from "./useFundsPageController";
import { useBusinessPeriod } from "../shared/state/businessPeriod";
import { DepositSection, OverviewTab, CashflowTab, ReconciliationTab } from "./FundsPage.tabs";
import {
  CancelModal,
  CashflowModal,
  DepositModal,
  LossModal,
  ReconciliationModal,
  ReleaseModal,
  ResolveModal,
  ReverseModal,
  TransferModal,
} from "./FundsPage.modals";
export function FundsPage({ active = true }: { active?: boolean } = {}) {
  const periodState = useBusinessPeriod();
  const ctrl = useFundsPageController(active, periodState);
  return (
    <section className="ui-stack">
      <ErrorBanner error={ctrl.error} onRetry={() => void ctrl.load()} retrying={ctrl.loading} />
      <ErrorBanner error={periodState.error ? { message: periodState.error } : null} onRetry={periodState.retry} />
      <Tabs
        defaultActiveKey="overview"
        destroyOnHidden
        items={[
          {
            key: "overview",
            label: "总览",
            children: <OverviewTab ctrl={ctrl} />,
          },
          {
            key: "cashflows",
            label: "资金明细",
            children: <CashflowTab ctrl={ctrl} periodState={periodState} />,
          },
          { key: "studio-operations", label: "工作室运营", children: <StudioExpensePanel pools={ctrl.pools} ctrl={ctrl} periodState={periodState} /> },
          { key: "deposits", label: "押金", children: <DepositSection ctrl={ctrl} /> },
          { key: "reconciliations", label: "对账", children: <ReconciliationTab ctrl={ctrl} /> },
        ]}
      />
      <DepositModal ctrl={ctrl} />
      <CashflowModal ctrl={ctrl} />
      <TransferModal ctrl={ctrl} />
      <ReconciliationModal ctrl={ctrl} />
      <ResolveModal ctrl={ctrl} />
      <ReverseModal ctrl={ctrl} />
      <ReleaseModal ctrl={ctrl} />
      <LossModal ctrl={ctrl} />
      <CancelModal ctrl={ctrl} />
    </section>
  );
}
