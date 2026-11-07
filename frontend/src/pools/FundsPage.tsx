/** 资金中心：总览 / 流水 / 工作室支出 / 对账 / 异常。
 *  逻辑层见 useFundsPageController；视图层拆为 FundsPage.tabs 与 FundsPage.modals。 */
import { Tabs } from "antd";
import { ErrorBanner } from "../shared/ui";
import { RebatesPanel } from "../rebates/RebatesPanel";
import { StudioExpensePanel } from "./StudioExpensePanel";
import { useFundsPageController } from "./useFundsPageController";
import { OverviewTab, CashflowTab, ReconciliationTab, ControlsTab } from "./FundsPage.tabs";
import {
  CancelModal,
  CashflowModal,
  DepositModal,
  LossModal,
  ReconciliationModal,
  ReleaseModal,
  RepairModal,
  ResolveModal,
  ReverseModal,
  TransferModal,
  UnmatchedModal,
} from "./FundsPage.modals";
export function FundsPage({ active = true }: { active?: boolean } = {}) {
  const ctrl = useFundsPageController(active);
  return (
    <section className="ui-stack">
      <ErrorBanner error={ctrl.error} onRetry={() => void ctrl.load()} retrying={ctrl.loading} />
      <Tabs
        defaultActiveKey="overview"
        destroyOnHidden
        items={[
          { key: "overview", label: "总览", children: <OverviewTab ctrl={ctrl} /> },
          { key: "cashflows", label: "流水", children: <CashflowTab ctrl={ctrl} /> },
          { key: "reconciliations", label: "对账", children: <ReconciliationTab ctrl={ctrl} /> },
          { key: "controls", label: "异常", children: <ControlsTab ctrl={ctrl} /> },
          { key: "rebates", label: "返点明细", children: <RebatesPanel /> },
          { key: "studio-expenses", label: "工作室支出", children: <StudioExpensePanel pools={ctrl.pools} ctrl={ctrl} /> },
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
      <RepairModal ctrl={ctrl} />
      <UnmatchedModal ctrl={ctrl} />
    </section>
  );
}
