import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { today } from "../../shared/lib/format";
import { ordersApi } from "../../shared/api/orders.api";
import { InventoryRebateModal } from "../../stocks/InventoryRebateModal";
import { InventoryProfileModal, InventoryPlatformOffsaleModal } from "../../stocks/operations";
import { OrderDeliveryModal } from "../OrderDeliveryModal";
import { OrderDeleteDialog } from "../OrderDeleteDialog";
import { type OrdersPageController } from "./useOrdersPageController";
import { SharedCancellationDialog, CancelTransactionModal } from "./OrderCancellationModals";
import { AllocationModal } from "./OrderAllocationModal";
import { RefundModal } from "./OrderFinanceModals";
import { EditOrderModal, CreateBusinessModalWrapper, OrderAccountActionModals } from "./OrderActionModals";

export function OrderModals({ controller }: { controller: OrdersPageController }) {
  return (
    <>
      <SharedCancellationDialog controller={controller} />
      <CancelTransactionModal controller={controller} />
      <EditOrderModal controller={controller} />
      <AllocationModal controller={controller} />
      <RefundModal controller={controller} />
      <OrderDeleteDialog
        order={controller.orderDeleteTarget}
        submitting={controller.orderDeleteSubmitting}
        onCancel={() => controller.setOrderDeleteTarget(null)}
        onConfirm={controller.submitOrderDelete}
      />
      <OrderDeliveryModal
        target={controller.deliveryTarget}
        employees={controller.users}
        onClose={() => controller.setDeliveryTarget(null)}
        onCreated={async () => {
          controller.setDeliveryTarget(null);
          await controller.load();
        }}
      />
      <InventoryProfileModal
        target={controller.profileTarget}
        onClose={() => controller.setProfileTarget(null)}
        onSaved={(updated) => {
          const accountId = controller.profileTarget?.account.id ?? updated.id;
          controller.setProfileTarget(null);
          void controller.loadLedgerDetail(accountId, true);
          void controller.load();
        }}
        onError={(error) => appMessage.error(normalizeError(error).message)}
        onOperation={async (operationType) => {
          const target = controller.profileTarget;
          const orderId = target?.orderId ?? target?.account.source_order_id;
          if (!orderId) throw new Error("账号没有可关联的来源订单，无法登记运营事件");
          await ordersApi.postEvent(orderId, {
            event_type: "OPERATE",
            operation_type: operationType,
            occurred_on: today(),
            note: operationType === "IMAGE" ? "订单台账登记作图" : "订单台账登记描述",
            form_extra_scope: "OPERATION",
          });
        }}
      />
      <InventoryPlatformOffsaleModal
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
