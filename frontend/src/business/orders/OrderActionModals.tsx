import { CreateBusinessModal } from "../shared/order-create/CreateBusinessModal";
import { OrderConsignmentModal } from "../shared/operations";
import { ConsignmentSaleModal, PickupSaleModal, RecoverySaleModal } from "../shared/sale";
import { type OrdersPageController } from "./useOrdersPageController";

export function CreateBusinessModalWrapper({ controller }: { controller: OrdersPageController }) {
  const {
    createType,
    activeTab,
    load,
    setCreateType,
    setInventoryRefreshKey,
  } = controller;
  return (
      <CreateBusinessModal
        open={Boolean(createType)}
        onClose={() => setCreateType(undefined)}
        onCreated={async () => {
          setInventoryRefreshKey((key) => key + 1);
          if (activeTab !== "ledger") return;
          await load();
        }}
        initialOrderType={createType ?? "HS"}
      />
  );
}

export function OrderAccountActionModals({ controller }: { controller: OrdersPageController }) {
  const sale = controller.orderSaleTarget;
  const saleCommon = {
    account: sale,
    onClose: controller.closeOrderSale,
    onCreated: async () => {
      await controller.load();
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
        onCreated={async () => {
          await controller.load();
        }}
      />
    </>
  );
}
