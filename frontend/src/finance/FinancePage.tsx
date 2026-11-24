/** 资金中心：总览 / 资金明细 / 工作室运营 / 对账 / 押金。
 *  逻辑层见 useFinancePageController；视图层拆为 FinancePage.tabs 与 FinancePage.modals。 */
import { Tabs } from "antd";
import { useState } from "react";
import { ErrorBanner } from "../shared/ui";
import { StudioExpensePanel } from "./StudioExpensePanel";
import { useFinancePageController } from "./useFinancePageController";
import { useBusinessPeriod } from "../shared/state/businessPeriod";
import { DepositSection, OverviewTab, CashflowTab, ReconciliationTab } from "./FinancePage.tabs";
import {
  CancelModal,
  DepositModal,
  LossModal,
  ReconciliationModal,
  ReleaseModal,
  ResolveModal,
  TransferModal,
} from "./FinancePage.modals";
export function FinancePage({ active = true }: { active?: boolean } = {}) {
  const periodState = useBusinessPeriod();
  const [activeTab, setActiveTab] = useState("overview");
  const ctrl = useFinancePageController(active, periodState, active && activeTab === "cashflows");
  return (
    <section className="ui-stack">
      <ErrorBanner error={ctrl.fundsError} onRetry={() => void ctrl.reloadFunds()} retrying={ctrl.fundsLoading} />
      <ErrorBanner error={periodState.error ? { message: periodState.error } : null} onRetry={periodState.retry} />
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
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
      <TransferModal ctrl={ctrl} />
      <ReconciliationModal ctrl={ctrl} />
      <ResolveModal ctrl={ctrl} />
      <ReleaseModal ctrl={ctrl} />
      <LossModal ctrl={ctrl} />
      <CancelModal ctrl={ctrl} />
    </section>
  );
}
