import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { CashflowModal } from "../../finance/cashflow";
import { InventoryRebateModal } from "../stocks/rebate";
import { OrderProfileModal, OrderPlatformOffsaleModal } from "../operations";
import { OrderDeleteDialog } from "../OrderDeleteDialog";
import { type OrdersPageController } from "./useOrdersPageController";
import { SharedCancellationDialog, CancelTransactionModal } from "./OrderCancellationModals";
import { AllocationModal } from "./OrderAllocationModal";
import { CreateBusinessModalWrapper, OrderAccountActionModals } from "./OrderActionModals";

export function OrderModals({ controller }: { controller: OrdersPageController }) {
  return (
    <>
      <SharedCancellationDialog controller={controller} />
      <CancelTransactionModal controller={controller} />
      <AllocationModal controller={controller} />
      <CashflowModal
        target={controller.cashflowTarget}
        pools={controller.cashflowPools}
        users={controller.cashflowUsers}
        scope="REFUND"
        showOperator
        showDetails
        currentOperator={controller.currentOperator}
        onClose={() => controller.setCashflowTarget(null)}
        onCreated={async () => {
          controller.setCashflowTarget(null);
          await controller.load();
        }}
      />
      <OrderDeleteDialog
        order={controller.orderDeleteTarget}
        submitting={controller.orderDeleteSubmitting}
        onCancel={() => controller.setOrderDeleteTarget(null)}
        onConfirm={controller.submitOrderDelete}
      />
      <OrderProfileModal
        target={controller.profileTarget}
        onClose={() => controller.setProfileTarget(null)}
        onSaved={(updated) => {
          const orderId = controller.profileTarget?.orderId ?? updated.source_order_id;
          controller.setProfileTarget(null);
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
        onClose={() => controller.setOrderOffsaleTarget(null)}
        onSystemOffsale={controller.handleOrderSystemOffsale}
        onChanged={controller.handleOrderOffsaleChanged}
      />
      <InventoryRebateModal
        account={controller.orderRebateTarget}
        onClose={() => controller.setOrderRebateTarget(null)}
        onCreated={async () => {
          controller.setOrderRebateTarget(null);
          await controller.load();
        }}
      />
      <OrderAccountActionModals controller={controller} />
      <CreateBusinessModalWrapper controller={controller} />
    </>
  );
}
