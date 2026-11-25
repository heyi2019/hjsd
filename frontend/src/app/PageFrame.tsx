import { lazy, memo } from "react";
import type { ComponentType, RefObject } from "react";
import { WorkbenchPage } from "../workbench/WorkbenchPage";
import { ErrorBoundary } from "../shared/ui/ErrorBoundary";
import { DataTableLoadingProvider } from "../shared/ui/DataTable";
import type { BusinessCenterEntryTab } from "../business/businessCenter";
import type { InitialLedgerFilters } from "../business/orders/useLedgerList";

const OrdersPage = lazy(() => import("../business/OrdersPage").then(({ OrdersPage }) => ({ default: OrdersPage })));
const CustomersPage = lazy(() => import("../customers/CustomersPage").then(({ CustomersPage }) => ({ default: CustomersPage })));
const FinancePage = lazy(() => import("../finance/FinancePage").then(({ FinancePage }) => ({ default: FinancePage })));
const ReportsPage = lazy(() => import("../operations/ReportsPage").then(({ ReportsPage }) => ({ default: ReportsPage })));
const SettingsPage = lazy(() => import("../settings/SettingsPage").then(({ SettingsPage }) => ({ default: SettingsPage })));

// 注：workbench 不入此映射——工作台是纯动作入口（无跳转需求），由下方三元单独渲染；
// 其余页面统一收 onNavigate（ReportsPage 的数据中心入口卡跳业务中心用），无跳转需求的页面忽略该 prop。
export type PageProps = {
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
  initialTab?: BusinessCenterEntryTab;
  initialMine?: boolean;
  initialLedgerFilters?: InitialLedgerFilters;
  initialAllocationOrderId?: number;
  initialAllocationNotificationId?: number;
  initialInventoryAgeGtDays?: number;
  initialInstallmentStatus?: string;
  initialReportTab?: "commission" | "my-earnings";
  initialReportFrom?: string;
  initialReportTo?: string;
  initialReportAll?: boolean;
  /** keep-alive 下当前页是否处于激活态：非激活仅隐藏不卸载，页面可据此在重新激活时重拉数据。 */
  active?: boolean;
  /** Customer Center deep-link focus, passed from the shell so standalone page tests need no Router context. */
  focusCustomerId?: number;
  focusCounterpartyId?: number;
  customerOrderFilter?: { from?: string; to?: string };
  onClearCustomerOrderFilter?: () => void;
};

export const PAGES: Record<string, ComponentType<PageProps>> = {
  business: OrdersPage,
  customers: CustomersPage,
  funds: FinancePage,
  operations: ReportsPage,
  settings: SettingsPage,
};

/** keep-alive 页面槽位。memo 化后，AppShell 因 userCenterOpen / moreOpen / 主题等
 *  无关 state 重渲染时，props 未变的隐藏页跳过整棵子树重渲染。
 *
 *  关键：传给各页面的 props 必须摊平为「原始值或稳定引用」——对象/回调若在
 *  AppShell 每次渲染新建，浅比较必然失败，memo 就形同虚设。isActive 是原始值，
 *  切页变化时 props 必变，memo 自动放行（页面内 useEffect([active]) 照常重拉数据）。
 *  这是安全失败设计：漏稳定某个 prop 至多多渲染一次，不会导致数据该刷新却不刷新。 */
export type PageSlotProps = {
  slotKey: string;
  isActive: boolean;
  hostRef: RefObject<HTMLDivElement> | undefined;
  PageComponent: ComponentType<PageProps>;
  onNavigate: (key: string, tab?: BusinessCenterEntryTab) => void;
  onWorkbenchNavigate: (path: string) => void;
  initialTab?: BusinessCenterEntryTab;
  initialMine?: boolean;
  initialLedgerFilters?: InitialLedgerFilters;
  initialAllocationOrderId?: number;
  initialAllocationNotificationId?: number;
  initialInventoryAgeGtDays?: number;
  initialInstallmentStatus?: string;
  initialReportTab?: "commission" | "my-earnings";
  initialReportFrom?: string;
  initialReportTo?: string;
  initialReportAll?: boolean;
  focusCustomerId?: number;
  focusCounterpartyId?: number;
  customerOrderFilter?: { from?: string; to?: string };
  clearCustomerOrderFilter: () => void;
};

export const PageSlot = memo(function PageSlot({
  slotKey,
  isActive,
  hostRef,
  PageComponent,
  onNavigate,
  onWorkbenchNavigate,
  initialTab,
  initialMine,
  initialLedgerFilters,
  initialAllocationOrderId,
  initialAllocationNotificationId,
  initialInventoryAgeGtDays,
  initialInstallmentStatus,
  initialReportTab,
  initialReportFrom,
  initialReportTo,
  initialReportAll,
  focusCustomerId,
  focusCounterpartyId,
  customerOrderFilter,
  clearCustomerOrderFilter,
}: PageSlotProps) {
  return (
    <div
      ref={hostRef}
      className={`page-slot${slotKey === "business" || slotKey === "customers" ? " page-slot--quick-entry" : ""}${isActive ? " page-enter" : " page-slot--hidden"}`}
      aria-hidden={!isActive}
    >
      {/* 边界必须挂在 .page-slot 内部：挂在外面时降级卡会顶掉整个 slot，
          page-slot--hidden 随之消失，keep-alive 下隐藏页的错误卡就会叠到
          当前页底部（2026-11-03 实测库存/订单/分期/资金/报表/设置六处全现）。 */}
      <ErrorBoundary name={slotKey}>
        <DataTableLoadingProvider enabled={["business", "customers", "funds", "operations"].includes(slotKey)}>
          {slotKey === "workbench" ? (
            <WorkbenchPage active={isActive} onNavigate={onNavigate} onWorkbenchNavigate={onWorkbenchNavigate} />
          ) : (
            <PageComponent
              onNavigate={onNavigate}
              initialTab={initialTab}
              initialMine={initialMine}
              initialLedgerFilters={initialLedgerFilters}
              initialAllocationOrderId={initialAllocationOrderId}
              initialAllocationNotificationId={initialAllocationNotificationId}
              initialInventoryAgeGtDays={initialInventoryAgeGtDays}
              initialInstallmentStatus={initialInstallmentStatus}
              initialReportTab={initialReportTab}
              initialReportFrom={initialReportFrom}
              initialReportTo={initialReportTo}
              initialReportAll={initialReportAll}
              active={isActive}
              focusCustomerId={focusCustomerId}
              customerOrderFilter={customerOrderFilter}
              onClearCustomerOrderFilter={slotKey === "customers" ? clearCustomerOrderFilter : undefined}
              focusCounterpartyId={focusCounterpartyId}
            />
          )}
        </DataTableLoadingProvider>
      </ErrorBoundary>
    </div>
  );
});
