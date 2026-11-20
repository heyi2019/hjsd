import { BusinessActionModal } from "../../../shared/ui";
import { money } from "../../../shared/lib/format";
import { appMessage } from "../../../shared/ui/appFeedback";
import { currentDevUser, normalizeError } from "../../../shared/api/client";
import { ordersApi } from "../../../shared/api/orders.api";
import { InventoryCancellationDialog } from "../InventoryCancellationDialog";
import { InventoryDeleteDialog } from "./InventoryDeleteDialog";
import { OrderConsignmentModal, OrderPlatformOffsaleModal, OrderProfileModal } from "../../operations";
import { InventoryRebateModal } from "../rebate";
import { CashflowModal } from "../../../finance/cashflow";
import { ConsignmentSaleModal, PickupSaleModal, RecoverySaleModal } from "../sale";
import { OrderDetail } from "../../OrderDetailView/OrderDetail";
import type { InventoryController } from "./useInventoryController";
import { mergeInventoryAccount } from "./types";

export function InventoryModals({ controller }: { controller: InventoryController }) {
  const {
    cancelInlineEdit,
    consignmentTarget,
    deleteTarget,
    deleting,
    detailTarget,
    editingAccount,
    employees,
    pools,
    operatorUsername,
    eventDrafts,
    financeDrafts,
    executionDetails,
    executionLoading,
    inlineEditId,
    invEditExtraForm,
    load,
    loadExecution,
    platformOffsaleTarget,
    profileTarget,
    rebateTarget,
    removeFromInventory,
    cashflowPools,
    cashflowTarget,
    cashflowUsers,
    refreshExecution,
    saleTarget,
    saveInline,
    savingAccount,
    setConsignmentTarget,
    setDeleteTarget,
    setDetailTarget,
    setExecutionDetails,
    setPlatformOffsaleTarget,
    setProfileTarget,
    setRebateTarget,
    closeCashflow,
    setSaleTarget,
    submitDelete,
    submitVoid,
    updateEventDraft,
    updateFinanceDraft,
    updateEditingAccount,
    orderDrafts,
    updateOrderDraft,
    updatePartyDraft,
    voidForm,
    voidPools,
    voidTarget,
    voiding,
    closeVoid,
  } = controller;

  return (
    <>
      {saleTarget ? (() => {
        const onCreated = async (account: NonNullable<typeof saleTarget>) => {
          removeFromInventory(account.id, account.source_order_id ?? undefined);
          await load();
          controller.dropExecutionCache(account.id);
        };
        const common = { account: saleTarget, onClose: () => setSaleTarget(null), onCreated };
        if (saleTarget.inventory_type === "CONSIGNMENT") return <ConsignmentSaleModal {...common} />;
        if (saleTarget.inventory_type === "PICKUP") return <PickupSaleModal {...common} />;
        return <RecoverySaleModal {...common} />;
      })() : null}
      <OrderConsignmentModal
        account={consignmentTarget}
        onClose={() => setConsignmentTarget(null)}
        onCreated={async (account) => {
          await load();
          refreshExecution(account);
        }}
      />
      <InventoryRebateModal
        account={rebateTarget}
        onClose={() => setRebateTarget(null)}
        onCreated={async (account) => {
          await load();
          refreshExecution(account);
        }}
      />
      <CashflowModal
        target={cashflowTarget}
        pools={cashflowPools}
        users={cashflowUsers}
        scope="REFUND"
        showOperator
        showDetails
        currentOperator={currentDevUser()}
        onClose={closeCashflow}
        onCreated={async (createdTarget) => {
          const account = createdTarget.account;
          await load();
          if (account) refreshExecution(account);
        }}
      />
      <InventoryCancellationDialog
        title={voidTarget ? `取消入库登记 · ${voidTarget.account.source_order_no ?? voidTarget.account.stock_no ?? `账号 ${voidTarget.account.id}`}` : "取消入库登记"}
        open={Boolean(voidTarget)}
        okText="确认冲销"
        submitting={voiding}
        form={voidForm}
        scope="INVOID"
        amount={voidTarget?.amount ?? "0.00"}
        allowZeroRefund
        pools={voidPools}
        onCancel={closeVoid}
        onFinish={(values) => void submitVoid(values)}
        description={voidTarget ? <p className="muted">
          来源订单买入流水剩余可冲销 ¥{money(voidTarget.amount)}。按实际退回金额冲销，取消后账号退出库存，同时关闭仍在上架的平台记录。
          冲销不可撤销，历史轨迹保留。
        </p> : null}
      />
      <OrderPlatformOffsaleModal
        account={platformOffsaleTarget?.account ?? null}
        records={platformOffsaleTarget?.records ?? []}
        onClose={() => setPlatformOffsaleTarget(null)}
        onSystemOffsale={async ({ reason, unlisted_at, operator_user_ids, form_extra }) => {
          const target = platformOffsaleTarget;
          if (!target?.account.source_order_id) throw new Error("当前账号没有可出库的来源订单");
          try {
            await ordersApi.inventoryOffsale(target.account.source_order_id, {
              reason,
              operator_user_ids,
              occurred_on: unlisted_at.slice(0, 10),
              unlisted_at,
              form_extra,
            });
            appMessage.success("寄售记录已下架，账号已出库");
            void load();
            refreshExecution(target.account);
          } catch (cause) {
            void load();
            throw cause;
          }
        }}
        onChanged={async () => {
          const account = platformOffsaleTarget?.account;
          if (!account?.source_order_id) return;
          await load();
          const detail = await ordersApi.executionDetail(account.source_order_id);
          setExecutionDetails((current) => ({ ...current, [account.id]: detail }));
        }}
      />
      <BusinessActionModal
        className="inventory-detail-modal"
        title={inlineEditId === detailTarget?.id ? "编辑详情" : "库存详情"}
        open={Boolean(detailTarget)}
        footer={null}
        width="min(1200px, calc(100vw - 24px))"
        onCancel={() => cancelInlineEdit()}
      >
        {detailTarget ? <OrderDetail
          row={detailTarget}
          detail={executionDetails[detailTarget.id]}
          loading={Boolean(executionLoading[detailTarget.id])}
          onPartyClick={controller.openPartyCard}
          editing={inlineEditId === detailTarget.id ? editingAccount : undefined}
          eventDrafts={eventDrafts}
          onEventEdit={updateEventDraft}
          financeDrafts={financeDrafts}
          onFinanceEdit={updateFinanceDraft}
          onProfileChange={updateEditingAccount}
          orderDrafts={orderDrafts}
          onOrderEdit={updateOrderDraft}
          onOrderExtraChange={(orderId, key, value) => updateOrderDraft(orderId, { form_extra: { [key]: value } })}
          onPartyEdit={updatePartyDraft}
          employees={employees}
          pools={pools}
          operatorUsername={operatorUsername}
          extraForm={invEditExtraForm}
          onSave={saveInline}
          onCancel={cancelInlineEdit}
          saving={savingAccount}
        /> : null}
      </BusinessActionModal>
      <OrderProfileModal
        target={profileTarget}
        onClose={() => setProfileTarget(null)}
        onSaved={(updated, target) => {
          controller.setRows((current) => current.map((row) => row.account.id === updated.id ? mergeInventoryAccount(row, updated) : row));
          setExecutionDetails((current) => {
            const detail = current[updated.id];
            return detail ? { ...current, [updated.id]: { ...detail, account: { ...detail.account, ...updated } } } : current;
          });
          refreshExecution(updated, target.orderId ?? updated.source_order_id);
        }}
        onError={(error) => controller.setError(normalizeError(error))}
        operationSource="库存中心"
      />
      {/* 删除确认与其它弹窗同级渲染：嵌套进受控 Modal 的 children 会被父级 open=false 打断关闭渲染。 */}
      <InventoryDeleteDialog
        account={deleteTarget}
        submitting={deleting}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={(reason) => submitDelete(reason)}
      />
    </>
  );
}
