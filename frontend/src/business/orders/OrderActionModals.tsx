import { lazy, Suspense } from "react";
import { OrderConsignmentModal } from "../shared/operations";
import { ConsignmentSaleModal, PickupSaleModal, RecoverySaleModal } from "../shared/sale";
import { type OrdersPageController } from "./useOrdersPageController";

const CreateBusinessModal = lazy(() => import("../shared/order-create/CreateBusinessModal")
  .then(({ CreateBusinessModal }) => ({ default: CreateBusinessModal })));

export function CreateBusinessModalWrapper({ controller }: { controller: OrdersPageController }) {
  const {
    createType,
    activeTab,
    load,
    setCreateType,
    setInventoryRefreshKey,
  } = controller;
  if (!createType) return null;
  return (
    <Suspense fallback={<div role="status">正在打开建单表单…</div>}>
      <CreateBusinessModal
        open
        onClose={() => setCreateType(undefined)}
        onCreated={async () => {
          setInventoryRefreshKey((key) => key + 1);
          if (activeTab !== "ledger") return;
          await load();
        }}
        initialOrderType={createType}
      />
    </Suspense>
  );
}

export function OrderAccountActionModals({ controller }: { controller: OrdersPageController }) {
  const sale = controller.orderSaleTarget;
  const saleCommon = {
    account: sale,
    onClose: controller.closeOrderSale,
    onCreated: async (account: NonNullable<typeof sale>) => {
      await Promise.all([
        controller.load(),
        account.source_order_id == null ? undefined : controller.refreshCachedLedgerDetail(account.source_order_id, account.id),
      ]);
    },
  };
  const consignment = controller.orderConsignmentTarget;
  return (
    <>
      {sale?.inventory_type === "CONSIGNMENT"
        ? <ConsignmentSaleModal {...saleCommon} />
        : sale?.inventory_type === "PICKUP"
          ? <PickupSaleModal {...saleCommon} />
          : <RecoverySaleModal {...saleCommon} />}
      <OrderConsignmentModal
        account={consignment?.account ?? null}
        orderId={consignment?.orderId}
        onClose={controller.closeOrderConsignment}
        onCreated={async (account, orderId) => {
          await Promise.all([controller.load(), controller.refreshCachedLedgerDetail(orderId, account.id)]);
        }}
      />
    </>
  );
}
