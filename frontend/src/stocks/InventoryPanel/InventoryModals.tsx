import { BusinessActionModal } from "../../shared/ui";
import { money } from "../../shared/lib/format";
import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { ordersApi, stocksApi } from "../../shared/api/catalog";
import { InventoryCancellationDialog } from "../InventoryCancellationDialog";
import { InventoryDeleteDialog } from "./InventoryDeleteDialog";
import { InventoryConsignmentModal } from "../InventoryConsignmentModal";
import { InventoryPlatformOffsaleModal } from "../InventoryPlatformOffsaleModal";
import { InventoryProfileModal } from "../InventoryProfileModal";
import { InventoryRebateModal } from "../InventoryRebateModal";
import { ConsignmentSaleModal, PickupSaleModal, RecoverySaleModal } from "../InventorySaleModal";
import { OrderDetail } from "../OrderDetail";
import type { InventoryController } from "./useInventoryController";

export function InventoryModals({ controller }: { controller: InventoryController }) {
  const {
    cancelInlineEdit,
    consignmentTarget,
    deleteTarget,
    deleting,
    detailTarget,
    editingAccount,
    employees,
    eventDrafts,
    executionDetails,
    executionLoading,
    inlineEditId,
    invEditExtraForm,
    load,
    onOrdersChanged,
    platformOffsaleTarget,
    profileTarget,
    rebateTarget,
    removeFromInventory,
    refreshExecution,
    saleTarget,
    saveInline,
    savingAccount,
    setConsignmentTarget,
    setDeleteTarget,
    setExecutionDetails,
    setPlatformOffsaleTarget,
    setProfileTarget,
    setRebateTarget,
    setSaleTarget,
    submitDelete,
    submitVoid,
    updateEventDraft,
    voidForm,
    voidPools,
    voidTarget,
    voiding,
  } = controller;

  return (
    <>
      {saleTarget ? (() => {
        const onCreated = async () => {
          const account = saleTarget;
          setSaleTarget(null);
          if (account) removeFromInventory(account.id);
          await load();
          if (account) controller.dropExecutionCache(account.id);
          onOrdersChanged?.();
        };
        const common = { account: saleTarget, onClose: () => setSaleTarget(null), onCreated };
        if (saleTarget.inventory_type === "CONSIGNMENT") return <ConsignmentSaleModal {...common} />;
        if (saleTarget.inventory_type === "PICKUP") return <PickupSaleModal {...common} />;
        return <RecoverySaleModal {...common} />;
      })() : null}
      <InventoryConsignmentModal
        account={consignmentTarget}
        onClose={() => setConsignmentTarget(null)}
        onCreated={async () => {
          const account = consignmentTarget;
          setConsignmentTarget(null);
          await load();
          if (account) refreshExecution(account);
          onOrdersChanged?.();
        }}
      />
      <InventoryRebateModal
        account={rebateTarget}
        onClose={() => setRebateTarget(null)}
        onCreated={async () => {
          const account = rebateTarget;
          setRebateTarget(null);
          await load();
          if (account) refreshExecution(account);
          onOrdersChanged?.();
        }}
      />
      <InventoryCancellationDialog
        title="系统下架登记"
        open={Boolean(voidTarget)}
        okText="确认下架"
        submitting={voiding}
        form={voidForm}
        scope="INVOID"
        amount={voidTarget?.amount ?? "0.00"}
        pools={voidPools}
        onCancel={() => { if (!voiding) { controller.setVoidTarget(null); voidForm.resetFields(); } }}
        onFinish={(values) => void submitVoid(values)}
        description={voidTarget ? <p className="muted">
          将按来源订单全额冲销该账号的买入流水（¥{money(voidTarget.amount)}），账号状态变为「下架」并退出在库统计；
          这是 ERP 系统下架，不影响已登记的寄售平台历史记录。下架不可撤销，历史轨迹保留。
        </p> : null}
      />
      <InventoryPlatformOffsaleModal
        account={platformOffsaleTarget?.account ?? null}
        records={platformOffsaleTarget?.records ?? []}
        onClose={() => setPlatformOffsaleTarget(null)}
        onSystemOffsale={async ({ reason, form_extra }) => {
          const target = platformOffsaleTarget;
          setPlatformOffsaleTarget(null);
          if (!target || target.records.length === 0) return;
          try {
            await Promise.all(target.records.map((record) => ordersApi.cancel(record.orderId, {
              reason,
              form_extra_scope: "INVOID",
              form_extra: { ...form_extra, platform_unlist_scope: "SYSTEM", platform_unlisted_at: new Date().toISOString().slice(0, 16) },
            })));
            appMessage.success("代挂订单已取消，账号已出库");
            await load();
            refreshExecution(target.account);
            onOrdersChanged?.();
          } catch (cause) {
            controller.setError(normalizeError(cause));
            await load();
          }
        }}
        onChanged={async () => {
          const accountId = platformOffsaleTarget?.account.id;
          setPlatformOffsaleTarget(null);
          if (!accountId) return;
          await load();
          const detail = await stocksApi.executionDetail(accountId);
          setExecutionDetails((current) => ({ ...current, [accountId]: detail }));
          onOrdersChanged?.();
        }}
      />
      <BusinessActionModal
        className="inventory-detail-modal"
        title={inlineEditId === detailTarget?.id ? "编辑账号" : "库存详情"}
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
          onEdit={controller.setEditingAccount}
          eventDrafts={eventDrafts}
          onEventEdit={updateEventDraft}
          employees={employees}
          extraForm={invEditExtraForm}
          onSave={saveInline}
          onCancel={cancelInlineEdit}
          saving={savingAccount}
        /> : null}
      </BusinessActionModal>
      <InventoryProfileModal
        target={profileTarget}
        onClose={() => setProfileTarget(null)}
        onSaved={(updated) => {
          controller.setRows((current) => current.map((row) => row.id === updated.id ? { ...row, ...updated } : row));
          setExecutionDetails((current) => {
            const detail = current[updated.id];
            return detail ? { ...current, [updated.id]: { ...detail, account: { ...detail.account, ...updated } } } : current;
          });
        }}
        onError={(error) => controller.setError(normalizeError(error))}
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
