/** 业务中心：库存中心、订单台账与分期回款。 */
import { Dropdown, Tabs } from "antd";
import { InventoryPanel } from "../stocks/InventoryPanel";
import { InstallmentsPanel } from "../installments/InstallmentsPanel";
import { ErrorBanner, PermissionButton } from "../shared/ui";
import type { BusinessOrderType } from "./CreateBusinessModal";
import { BUSINESS_CREATE_ITEMS } from "./orderpage/helpers";
import { OrdersLedgerPanel } from "./orderpage/OrdersLedgerPanel";
import { OrderModals } from "./orderpage/OrdersPage.modals";
import { useOrdersPageController } from "./orderpage/useOrdersPageController";
import type { BusinessCenterEntryTab, BusinessCenterTab } from "./businessCenter";

export { validateAllocations } from "./orderpage/helpers";
export type { AllocationItem, AllocationValidation } from "./orderpage/helpers";

export function OrdersPage({ initialTab, initialMine = false, active = true, onNavigate }: {
  initialTab?: BusinessCenterEntryTab;
  initialMine?: boolean;
  active?: boolean;
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
} = {}) {
  const controller = useOrdersPageController({ initialTab, initialMine, active, onNavigate });
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

  return (
    <section className="ui-stack orders-page">
      <ErrorBanner error={loadError} onRetry={() => void load()} retrying={loading} />
      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as BusinessCenterTab)}
        tabBarExtraContent={(
          <Dropdown
            menu={{ items: BUSINESS_CREATE_ITEMS, onClick: ({ key }) => setCreateType(key as BusinessOrderType) }}
            trigger={["click"]}
          >
            <PermissionButton permission="order.create" type="primary">新建订单</PermissionButton>
          </Dropdown>
        )}
        items={[
          {
            key: "inventory",
            label: "库存中心",
            children: <InventoryPanel active={active} refreshKey={inventoryRefreshKey} onOrdersChanged={() => { setInstallmentRefreshKey((key) => key + 1); void load(); }} onNavigate={onNavigate} />,
          },
          {
            key: "ledger",
            label: "订单台账",
            children: <OrdersLedgerPanel controller={controller} onNavigate={onNavigate} />,
          },
          {
            key: "collections",
            label: "分期与回款",
            children: <InstallmentsPanel refreshKey={installmentRefreshKey} />,
          },
        ]}
      />
      <OrderModals controller={controller} />
    </section>
  );
}
