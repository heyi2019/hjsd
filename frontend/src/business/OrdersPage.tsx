/** 业务中心：库存中心、订单台账与分期回款。 */
import { lazy, Suspense, useState } from "react";
import { Dropdown, Tabs } from "antd";
import { ErrorBanner, PermissionButton } from "../shared/ui";
import { appMessage } from "../shared/ui/appFeedback";
import { installmentsApi } from "../shared/api/installments.api";
import { normalizeError } from "../shared/api/client";
import type { BusinessOrderType } from "./shared/order-create/CreateBusinessModal";
import { BUSINESS_CREATE_ITEMS } from "./orders/helpers";
import { OrderModals } from "./orders/OrdersPage.modals";
import { useOrdersPageController } from "./orders/useOrdersPageController";
import type { InitialLedgerFilters } from "./orders/useLedgerList";
import type { BusinessCenterEntryTab, BusinessCenterTab } from "./businessCenter";

const InventoryPanel = lazy(() => import("./inventory/InventoryPanel")
  .then(({ InventoryPanel }) => ({ default: InventoryPanel })));
const OrdersLedgerPanel = lazy(() => import("./orders/OrdersLedgerPanel")
  .then(({ OrdersLedgerPanel }) => ({ default: OrdersLedgerPanel })));
const InstallmentsPanel = lazy(() => import("./installments/InstallmentsPanel")
  .then(({ InstallmentsPanel }) => ({ default: InstallmentsPanel })));
const loadingTab = <div className="page-loading" role="status" aria-busy="true">正在打开…</div>;

export function OrdersPage({ initialTab, initialMine = false, initialLedgerFilters, initialAllocationOrderId, initialAllocationNotificationId, initialInstallmentStatus, initialInventoryAgeGtDays, active = true, onNavigate }: {
  initialTab?: BusinessCenterEntryTab;
  initialMine?: boolean;
  initialLedgerFilters?: InitialLedgerFilters;
  initialAllocationOrderId?: number;
  initialAllocationNotificationId?: number;
  initialInstallmentStatus?: string;
  initialInventoryAgeGtDays?: number;
  active?: boolean;
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
} = {}) {
  const controller = useOrdersPageController({ initialTab, initialMine, initialLedgerFilters, initialAllocationOrderId, initialAllocationNotificationId, active, onNavigate });
  const {
    activeTab,
    installmentRefreshKey,
    inventoryRefreshKey,
    load,
    loadError,
    loading,
    setActiveTab,
    setCreateType,
    setInstallmentRefreshKey,
  } = controller;
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [markingOverdue, setMarkingOverdue] = useState(false);
  const handleTabChange = (key: BusinessCenterTab) => {
    setActiveTab(key);
  };
  const markOverdue = async () => {
    setMarkingOverdue(true);
    try {
      const result = await installmentsApi.markOverdue();
      appMessage.success(result.marked > 0 ? `已标记 ${result.marked} 笔逾期` : "当前无新增逾期合约");
      setInstallmentRefreshKey((key) => key + 1);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setMarkingOverdue(false);
    }
  };
  const createOrderAction = (
    <Dropdown
      open={createMenuOpen}
      onOpenChange={setCreateMenuOpen}
      menu={{
        items: BUSINESS_CREATE_ITEMS,
        onClick: ({ key }) => {
          setCreateMenuOpen(false);
          setCreateType(key as BusinessOrderType);
        },
      }}
      trigger={["click"]}
    >
      <PermissionButton permission="order.create" type="primary">新建订单</PermissionButton>
    </Dropdown>
  );

  return (
    <section className="ui-stack orders-page">
      {activeTab === "ledger" ? <ErrorBanner error={loadError} onRetry={() => void load()} retrying={loading} /> : null}
      <Tabs
        activeKey={activeTab}
        destroyOnHidden
        onChange={(key) => handleTabChange(key as BusinessCenterTab)}
        tabBarExtraContent={activeTab === "collections" ? (
          <PermissionButton permission="order.event.post" size="small" loading={markingOverdue} onClick={() => void markOverdue()}>
            标记逾期
          </PermissionButton>
        ) : undefined}
        items={[
          {
            key: "inventory",
            label: "库存中心",
            children: (
              <Suspense fallback={loadingTab}>
                <InventoryPanel active={active} refreshKey={inventoryRefreshKey} initialAgeGtDays={initialInventoryAgeGtDays} onNavigate={onNavigate} createAction={createOrderAction} />
              </Suspense>
            ),
          },
          {
            key: "ledger",
            label: "订单台账",
            children: (
              <Suspense fallback={loadingTab}>
                <OrdersLedgerPanel controller={controller} onNavigate={onNavigate} createAction={createOrderAction} />
              </Suspense>
            ),
          },
          {
            key: "collections",
            label: "分期与回款",
            children: (
              <Suspense fallback={loadingTab}>
                <InstallmentsPanel active={active} refreshKey={installmentRefreshKey} initialStatus={initialInstallmentStatus} />
              </Suspense>
            ),
          },
        ]}
      />
      <OrderModals controller={controller} onNavigate={onNavigate} />
    </section>
  );
}
