import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { CashflowModal } from "../../finance/cashflow";
import { InventoryRebateModal } from "../shared/rebate";
import { OrderProfileModal, OrderPlatformOffsaleModal } from "../shared/operations";
import { type OrdersPageController } from "./useOrdersPageController";
import { SharedCancellationDialog, CancelTransactionModal } from "./OrderCancellationModals";
import { AllocationModal } from "../profit_allocation/OrderAllocationModal";
import { CreateBusinessModalWrapper, OrderAccountActionModals } from "./OrderActionModals";

export function OrderModals({ controller, onNavigate }: { controller: OrdersPageController; onNavigate?: (key: string) => void }) {
  return (
    <>
      <SharedCancellationDialog controller={controller} />
      <CancelTransactionModal controller={controller} />
      <AllocationModal controller={controller} onNavigate={onNavigate} />
      <CashflowModal
        target={controller.cashflowTarget}
        pools={controller.cashflowPools}
        users={controller.cashflowUsers}
        showOperator
        showDetails
        currentOperator={controller.currentOperator}
        onClose={controller.closeCashflow}
        onCreated={async (target) => {
          await Promise.all([controller.load(), controller.refreshCachedLedgerDetail(target.orderId)]);
        }}
      />
      <OrderProfileModal
        target={controller.profileTarget}
        onClose={controller.closeOrderProfile}
        onSaved={(updated, target) => {
          const orderId = target.orderId ?? updated.source_order_id;
          if (orderId != null) {
            void controller.loadLedgerDetail({ id: orderId, account_id: updated.id }, true);
          }
          void controller.load();
        }}
        onError={(error) => appMessage.error(normalizeError(error).message)}
        operationSource="订单台账"
      />
      <OrderPlatformOffsaleModal
        account={controller.orderOffsaleTarget?.account ?? null}
        records={controller.orderOffsaleTarget?.records ?? []}
        onClose={controller.closeOrderOffsale}
        onSystemOffsale={controller.handleOrderSystemOffsale}
        onChanged={controller.handleOrderOffsaleChanged}
      />
      <InventoryRebateModal
        account={controller.orderRebateTarget}
        onClose={controller.closeOrderRebate}
        onCreated={async (account) => {
          await Promise.all([
            controller.load(),
            account.source_order_id == null ? undefined : controller.refreshCachedLedgerDetail(account.source_order_id, account.id),
          ]);
        }}
      />
      <OrderAccountActionModals controller={controller} />
      <CreateBusinessModalWrapper controller={controller} />
    </>
  );
}
