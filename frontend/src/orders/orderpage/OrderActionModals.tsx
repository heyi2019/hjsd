import { Input, Typography } from "antd";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../ConfigurableField";
import { CreateBusinessModal } from "../CreateBusinessModal";
import { DateField, BusinessActionModal, BusinessRegistrationForm, dateValueFromEvent, dateValueProps } from "../../shared/ui";
import { InventoryConsignmentModal } from "../../stocks/InventoryConsignmentModal";
import { ConsignmentSaleModal, PickupSaleModal, RecoverySaleModal } from "../../stocks/InventorySaleModal";
import { type OrdersPageController } from "./useOrdersPageController";

export function EditOrderModal({ controller }: { controller: OrdersPageController }) {
  const {
    editForm,
    editOpen,
    editSubmitting,
    orderHasPostedEvents,
    selectedOrder,
    setEditOpen,
    submitEditOrder,
  } = controller;
  return (
      <BusinessActionModal
        title={selectedOrder ? `编辑订单 · ${selectedOrder.order_no}` : "编辑订单"}
        fieldCount={7}
        open={editOpen}
        confirmLoading={editSubmitting}
        onCancel={() => { if (!editSubmitting) setEditOpen(false); }}
        okText="保存修改"
        onOk={() => void editForm.submit()}
      >
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="ORDEREDIT" form={editForm} onFinish={submitEditOrder}>
          <FieldConfigScope scope="ORDEREDIT" active={editOpen}>
          <Typography.Paragraph type="secondary">
            订单编号、业务类型、账号关联与状态不可编辑；修改成交日期会同步平移本单事件与资金流水日期，并重取返点/提成规则快照。
          </Typography.Paragraph>
          <CfgItem
            name="trade_date"
            label="成交日期"
            rules={[{ required: true, message: "请输入成交日期" }]}
            extra={orderHasPostedEvents ? "该单已有登记事件，改日期将同步平移事件与资金流水日期" : undefined}
            getValueFromEvent={dateValueFromEvent}
            getValueProps={dateValueProps}
          >
            <DateField />
          </CfgItem>
          <CfgItem name="note" label="备注">
            <Input.TextArea rows={2} placeholder="订单备注（选填）" />
          </CfgItem>

          <CustomFieldSection testIdSuffix="order-edit" />
          </FieldConfigScope>
        </BusinessRegistrationForm>
      </BusinessActionModal>
  );
}

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
        account={consignment}
        onClose={() => controller.setOrderConsignmentTarget(null)}
        onCreated={async () => {
          controller.setOrderConsignmentTarget(null);
          await controller.load();
        }}
      />
    </>
  );
}
