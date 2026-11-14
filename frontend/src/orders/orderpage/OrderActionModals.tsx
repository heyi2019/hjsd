import { CreateBusinessModal } from "../CreateBusinessModal";
import { InventoryConsignmentModal } from "../operations";
import { ConsignmentSaleModal, PickupSaleModal, RecoverySaleModal } from "../../stocks/sale";
import { type OrdersPageController } from "./useOrdersPageController";

export function CreateBusinessModalWrapper({ controller }: { controller: OrdersPageController }) {
  const {
    createType,
    load,
    setCreateType,
    setInstallmentRefreshKey,
    setInventoryRefreshKey,
  } = controller;
  return (
      <CreateBusinessModal
        open={Boolean(createType)}
        onClose={() => setCreateType(undefined)}
        onCreated={async () => {
          setCreateType(undefined);
          setInventoryRefreshKey((key) => key + 1);
          // 建单后同步重拉「分期回款」列表，覆盖售出分期等会生成新合约的场景。
          setInstallmentRefreshKey((key) => key + 1);
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
    onClose: () => controller.setOrderSaleTarget(null),
    onCreated: async () => {
      controller.setOrderSaleTarget(null);
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
      <InventoryConsignmentModal
        account={consignment?.account ?? null}
        orderId={consignment?.orderId}
        onClose={() => controller.setOrderConsignmentTarget(null)}
        onCreated={async () => {
          controller.setOrderConsignmentTarget(null);
          await controller.load();
        }}
      />
    </>
  );
}
