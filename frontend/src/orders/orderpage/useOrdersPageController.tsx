import { Form } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import { employeesApi } from "../../shared/api/org.api";
import { policyApi } from "../../shared/api/policy.api";
import { poolsApi } from "../../shared/api/pools.api";
import { stocksApi } from "../../shared/api/stocks.api";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import type { Pool } from "../../shared/api/types/finance";
import type { Order } from "../../shared/api/types/orders";
import { currentDevUser, currentUser, normalizeError } from "../../shared/api/client";
import { money, today } from "../../shared/lib/format";
import { appMessage } from "../../shared/ui/appFeedback";
import { consignmentRecords, type ActiveConsignment } from "../../stocks/InventoryPlatformOffsaleModal";
import { useAccountExecutionEditor } from "../../stocks/InventoryPanel/useAccountExecutionEditor";
import type { BusinessOrderType } from "../CreateBusinessModal";
import type { OrderDeliveryTarget } from "../OrderDeliveryModal";
import type { InventoryProfileTarget } from "../../stocks/InventoryProfileModal";
import { DEFAULT_BUSINESS_CENTER_TAB, type BusinessCenterEntryTab, type BusinessCenterTab } from "../businessCenter";
import {
  buildActionAllocationCandidates,
  buildActionAllocationRows,
  buildOrderPatchPayload,
  type ActionAllocationCandidates,
  type AllocationFormRow,
  type AllocationMode,
} from "./helpers";
import { useLedgerList } from "./useLedgerList";
import { useLedgerColumns } from "./useLedgerColumns";
import { useOrderCancellation } from "./useOrderCancellation";
import { useSession } from "../../shared/state/session";

export function useOrdersPageController(params: {
  active?: boolean;
  initialTab?: BusinessCenterEntryTab;
  initialMine?: boolean;
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
} = {}) {
  const { active = true, initialTab, initialMine = false, onNavigate } = params;
  const currentOperator = currentDevUser();
  const { role } = useSession();
  const canDeleteAccount = role === "admin";

  // —— 列表域：加载 / 筛选 / 分页 / 排序 / 导出 / 选项词典 / 派生 filteredOrders ——
  const list = useLedgerList({ active, initialMine });
  const {
    orders, setOrders, types, setTypes, loadError, setLoadError, loading, setLoading,
    page, setPage, pageSize, setPageSize,
    ledgerSortDesc, setLedgerSortDesc, ledgerExporting, setLedgerExporting,
    exportLedger, exportLedgerXlsx,
    orderTypeFilter, setOrderTypeFilter, businessModeFilter, setBusinessModeFilter,
    gameTypeFilter, setGameTypeFilter, inventoryStatusFilter, setInventoryStatusFilter,
    dateRange, setDateRange, keyword, setKeyword,
    orderBusinessOptions, orderBusinessModeOptions, profitRoleOptions, inventoryStatusOptions,
    gameTypeOptions, typeNames, filteredOrders, typeCountBase, load,
  } = list;

  // —— 表格详情 / 账号内联编辑枢纽 ——
  const [createType, setCreateType] = useState<BusinessOrderType | undefined>();
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  const [expandedOrderIds, setExpandedOrderIds] = useState<string[]>([]);
  const [ledgerDetails, setLedgerDetails] = useState<Record<number, AccountExecutionDetail>>({});
  const [ledgerDetailLoading, setLedgerDetailLoading] = useState<Record<number, boolean>>({});
  const loadLedgerDetail = async (accountId: number, force = false) => {
    if (!force && (ledgerDetails[accountId] || ledgerDetailLoading[accountId])) return;
    setLedgerDetailLoading((current) => ({ ...current, [accountId]: true }));
    try {
      const detail = await stocksApi.executionDetail(accountId);
      setLedgerDetails((current) => ({ ...current, [accountId]: detail }));
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setLedgerDetailLoading((current) => ({ ...current, [accountId]: false }));
    }
  };
  const accountEditor = useAccountExecutionEditor({
    getExecutionDetail: (id) => ledgerDetails[id],
    onSaved: (id, detail) => setLedgerDetails((current) => ({ ...current, [id]: detail })),
  });

  const openLedgerAccountEditor = async (account: Account) => {
    await accountEditor.openEditor(account);
  };

  const openLedgerEditor = async (order: Order) => {
    try {
      let accountId = order.account_id;
      if (accountId == null) {
        if (!['ACTIVE', 'INSTALLMENT'].includes(order.status)) {
          appMessage.warning("该历史订单未关联库存账号，当前状态不能补建库存");
          return;
        }
        const materialized = await ordersApi.materializeAccount(order.id);
        accountId = materialized.account_id;
        if (accountId == null) throw new Error("补建库存账号后未返回库存编号");
        setOrders((current) => current.map((item) => item.id === order.id ? { ...item, ...materialized } : item));
        appMessage.success("已补建库存账号");
      }
      const detail = ledgerDetails[accountId] ?? await stocksApi.executionDetail(accountId);
      setLedgerDetails((current) => ({ ...current, [accountId]: detail }));
      setExpandedOrderIds([String(order.id)]);
      await openLedgerAccountEditor(detail.account);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const handleLedgerExpand = (expanded: boolean, record: Order) => {
    // 手风琴：一次只展开一行，避免多行展开同时挂载多份详情导致 DOM 与页面长度翻倍。
    setExpandedOrderIds(expanded ? [String(record.id)] : []);
    if (expanded && record.account_id) void loadLedgerDetail(record.account_id);
  };

  const [refundOpen, setRefundOpen] = useState(false);
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [refundForm] = Form.useForm();
  const [allocationOpen, setAllocationOpen] = useState(false);
  const [allocationSubmitting, setAllocationSubmitting] = useState(false);
  const [allocationForm] = Form.useForm();
  const [profitShareOpen, setProfitShareOpen] = useState(false);
  const [profitShareSubmitting, setProfitShareSubmitting] = useState(false);
  const [profitSharePools, setProfitSharePools] = useState<Pool[]>([]);
  const [profitShareForm] = Form.useForm();
  const [orderRebateTarget, setOrderRebateTarget] = useState<Account | null>(null);
  const [orderSaleTarget, setOrderSaleTarget] = useState<Account | null>(null);
  const [orderConsignmentTarget, setOrderConsignmentTarget] = useState<Account | null>(null);
  const [orderDeleteTarget, setOrderDeleteTarget] = useState<Account | null>(null);
  const [deliveryTarget, setDeliveryTarget] = useState<OrderDeliveryTarget | null>(null);
  const [profileTarget, setProfileTarget] = useState<InventoryProfileTarget | null>(null);
  const [orderOffsaleTarget, setOrderOffsaleTarget] = useState<{ account: Account; records: ActiveConsignment[] } | null>(null);
  const [orderDeleteSubmitting, setOrderDeleteSubmitting] = useState(false);
  /** 订单总利润（后端 order_amounts 口径），负数即亏损单；分润弹窗顶部展示并作为金额分润上限。 */
  const [allocationProfit, setAllocationProfit] = useState<string>("0");
  /** 分润口径：按操作四项（买号/售出/运营/公司）或按人自由分配。默认按操作。 */
  const [allocationMode, setAllocationMode] = useState<AllocationMode>("ACTION");
  /** 按操作分配时的动作执行人候选，来自建单/售出负责人和运营信息中的操作人。 */
  const [allocationCandidates, setAllocationCandidates] = useState<ActionAllocationCandidates>({ BUY: [], SELL: [], OPERATION: [], COMPANY: [] });
  /** 当前登录人在员工花名册中的 ID：分润各行姓名默认取他，而不是默认某个角色。 */
  const [currentEmployeeId, setCurrentEmployeeId] = useState<number | undefined>(undefined);
  const [actionOrder, setActionOrder] = useState<Order | null>(null);
  const [users, setUsers] = useState<Array<{ id: number; username: string; display_name: string; is_active: boolean }>>([]);
  // 员工花名册 = 在职用户；另加「公司归属」用来表达留给公司、不绑定人的那部分。
  const employeeOptions = [
    ...users.map((item) => ({
      value: item.id as number | "COMPANY",
      label: `${item.display_name}（${item.username}）`,
    })),
    { value: "COMPANY" as number | "COMPANY", label: "公司（不绑定人员）" },
  ];
  /** 亏损单（总利润 < 0）：顶部提示改口径，金额分润后端也会拒绝。 */
  const allocationIsLoss = Number(allocationProfit) < 0;
  const [editOpen, setEditOpen] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editForm] = Form.useForm();

  const openAllocations = async (sourceOrder?: Order) => {
    try {
      const order = sourceOrder ? await ordersApi.get(sourceOrder.id) : selectedOrder;
      if (!order) return;
      const [result, userResult] = await Promise.all([
        policyApi.allocations(order.id),
        employeesApi.list(),
      ]);
      const candidates = buildActionAllocationCandidates(order);
      // 分润的「姓名」只能落在用户（users 表）上，取值一律走 /auth/me 的 id / username。
      // 不能用 session.role（ADMIN/OPERATOR 这类系统角色），
      // 也不能用 dev 用户名（currentDevUser 在无本地配置时兜底成 "admin"，不是登录人）。
      let currentId: number | undefined;
      try {
        const current = await currentUser();
        currentId = userResult.find(
          (item) => item.is_active && (item.id === current.id || item.username === current.username),
        )?.id;
      } catch {
        // 会话解析失败不阻断分润：姓名留空，由必填规则提示，绝不猜人。
      }
      setCurrentEmployeeId(currentId);
      const typed = result.items.filter((item) => item.allocation_type);
      const mode: AllocationMode = typed.length > 0 || result.items.length === 0 ? "ACTION" : "PERSON";
      setActionOrder(order);
      setUsers(userResult.filter((item) => item.is_active));
      setAllocationCandidates(candidates);
      setAllocationMode(mode);
      setAllocationProfit(result.order_profit ?? "0");
      // 分润两种录入口径：按操作四项（买号/售出/运营/公司）或按人头自由分配。
      // 存量行带 allocation_type 说明是按操作口径，原样回显；否则按人。
      // 角色必须原样带回表单：不回填就会在保存时被默认值 OWNER 覆盖掉。
      const rows: AllocationFormRow[] =
        mode === "ACTION"
          ? buildActionAllocationRows(result.items, candidates)
          : result.items.map((item) => ({
              employee: (item.user_id ?? "COMPANY") as number | "COMPANY",
              role: item.role || "OWNER",
              allocation_rate: item.allocation_rate,
              allocation_amount: item.allocation_amount ?? "",
            }));
      // 弹窗是复用的：先清空上次打开残留的字段（含 form_extra 自定义字段），再回填本单数据。
      allocationForm.resetFields();
      allocationForm.setFieldsValue({
        allocations: rows,
      });
      setAllocationOpen(true);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const openRefund = async (sourceOrder?: Order) => {
    try {
      const order = sourceOrder ? await ordersApi.get(sourceOrder.id) : selectedOrder;
      if (!order) return;
      const [employeeList, poolList] = await Promise.all([employeesApi.list(), poolsApi.list()]);
      setUsers(employeeList.filter((employee) => employee.is_active));
      const activePools = poolList.filter((pool) => pool.status === "ACTIVE");
      // 资金收支必须指认资金账户：带上可用池并默认选中第一个，用户仍可改。
      setCancelPools(activePools);
      setActionOrder(order);
      refundForm.resetFields();
      refundForm.setFieldsValue({
        direction: "OUT",
        category: "OTHER",
        pool_id: activePools[0]?.id,
      });
      setRefundOpen(true);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const openProfitShare = async (sourceOrder?: Order) => {
    try {
      const order = sourceOrder ? await ordersApi.get(sourceOrder.id) : selectedOrder;
      if (!order) return;
      const [poolList, employeeList] = await Promise.all([poolsApi.list(), employeesApi.list()]);
      const activePools = poolList.filter((pool) => pool.status === "ACTIVE");
      setUsers(employeeList.filter((employee) => employee.is_active));
      setProfitSharePools(activePools);
      setActionOrder(order);
      profitShareForm.resetFields();
      profitShareForm.setFieldsValue({
        occurred_on: dayjs(today()),
        pool_id: activePools[0]?.id,
      });
      setProfitShareOpen(true);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const submitProfitShare = async (values: {
    profit_recipient: "BUY" | "SELL" | "OPERATION" | "COMPANY";
    amount: string;
    occurred_on: Dayjs;
    pool_id: number;
    operator_user_ids?: number[];
    note?: string;
  }) => {
    if (!actionOrder) return;
    setProfitShareSubmitting(true);
    try {
      await ordersApi.postEvent(actionOrder.id, {
        event_type: "PROFIT_SHARE",
        profit_recipient: values.profit_recipient,
        amount: values.amount,
        occurred_on: values.occurred_on.format("YYYY-MM-DD"),
        pool_id: Number(values.pool_id),
        operator_user_ids: values.operator_user_ids,
        note: values.note,
      });
      appMessage.success("分润已登记，支出资金明细已生成");
      setProfitShareOpen(false);
      setActionOrder(null);
      if (actionOrder.account_id != null) await loadLedgerDetail(actionOrder.account_id, true);
      await load();
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setProfitShareSubmitting(false);
    }
  };

  const loadOrderAccount = async (sourceOrder: Order) => {
    if (!sourceOrder.account_id) {
      appMessage.warning("该订单未关联库存账号，无法执行账号动作");
      return null;
    }
    const detail = await stocksApi.executionDetail(sourceOrder.account_id);
    return detail.account;
  };

  const openOrderRebate = async (sourceOrder: Order) => {
    try {
      const account = await loadOrderAccount(sourceOrder);
      if (account) setOrderRebateTarget(account);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const openOrderSale = async (sourceOrder: Order) => {
    try {
      const account = await loadOrderAccount(sourceOrder);
      if (account) setOrderSaleTarget(account);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const openOrderConsignment = async (sourceOrder: Order) => {
    try {
      const account = await loadOrderAccount(sourceOrder);
      if (account) setOrderConsignmentTarget(account);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const openOrderDelete = async (sourceOrder: Order) => {
    try {
      const account = await loadOrderAccount(sourceOrder);
      if (account) setOrderDeleteTarget(account);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const openOrderDelivery = async (sourceOrder: Order) => {
    try {
      const order = await ordersApi.get(sourceOrder.id);
      const events = order.events ?? [];
      const direction: "BUY" | "SELL" =
        order.order_type === "DG" ||
        events.some((event) => event.event_type === "SELL") ||
        order.last_event_type === "SELL"
          ? "SELL"
          : "BUY";
      const alreadyDelivered = events.some(
        (event) => event.event_type === "DELIVER"
          && (event.delivery_direction ?? event.form_extra?.delivery_direction) === direction,
      );
      if (alreadyDelivered) {
        appMessage.warning(`${direction === "BUY" ? "买号" : "卖号"}交付已经登记`);
        return;
      }
      const employeeList = await employeesApi.list();
      setUsers(employeeList.filter((employee) => employee.is_active));
      setDeliveryTarget({
        orderId: order.id,
        orderNo: order.order_no,
        direction,
        boundPhone: order.account_snapshot?.bound_phone,
        boundPhoneOwner: order.account_snapshot?.bound_phone_owner,
      });
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const openOrderProfile = async (sourceOrder: Order, mode: "description" | "images") => {
    try {
      const account = await loadOrderAccount(sourceOrder);
      if (account) setProfileTarget({ account, mode, orderId: sourceOrder.id });
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const openOrderOffsale = async (sourceOrder: Order) => {
    try {
      if (!sourceOrder.account_id) {
        appMessage.warning("该订单未关联库存账号，无法下架");
        return;
      }
      const detail = await stocksApi.executionDetail(sourceOrder.account_id);
      const records = consignmentRecords(detail.orders);
      if (!records.length) {
        appMessage.warning("当前账号没有仍在平台上的寄售记录");
        return;
      }
      setOrderOffsaleTarget({ account: detail.account, records });
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const handleOrderSystemOffsale = async (payload: { reason: string; form_extra?: Record<string, unknown> }) => {
    const target = orderOffsaleTarget;
    if (!target) return;
    try {
      await Promise.all(target.records.map(async (record) => {
        await ordersApi.postEvent(record.orderId, {
          event_type: "OPERATE",
          operation_type: "UNLIST",
          occurred_on: today(),
          note: `系统下架：${payload.reason}`,
          form_extra_scope: "INVOID",
          form_extra: { ...payload.form_extra, platform_unlist_scope: "SYSTEM", platform_unlisted_at: new Date().toISOString().slice(0, 16) },
        });
        return ordersApi.cancel(record.orderId, {
          reason: payload.reason,
          form_extra_scope: "INVOID",
          form_extra: { ...payload.form_extra, platform_unlist_scope: "SYSTEM", platform_unlisted_at: new Date().toISOString().slice(0, 16) },
        });
      }));
      appMessage.success("代挂订单已取消，账号已出库");
      setOrderOffsaleTarget(null);
      await load();
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const handleOrderOffsaleChanged = async () => {
    setOrderOffsaleTarget(null);
    await load();
  };

  const submitOrderDelete = async (reason: string) => {
    if (!orderDeleteTarget) return;
    setOrderDeleteSubmitting(true);
    try {
      await stocksApi.remove(orderDeleteTarget.id, reason);
      appMessage.success("账号已删除，订单和资金明细已保留");
      setOrderDeleteTarget(null);
      await load();
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setOrderDeleteSubmitting(false);
    }
  };

  /** 编辑订单：后端限制——已有登记事件的订单只能改备注；账号快照仅特定业务可维护，
   *  且密码被后端隐去（无 order.create 权限）时不允许整体回写快照，避免覆盖隐藏密码。 */
  const openEditOrder = (order: Order) => {
    setSelectedOrder(order);
    const snapshot = order.account_snapshot;
    // 弹窗复用：CustomFieldSection 的 name 为 form_extra.<key> 且无 initialValue，
    // 不 reset 会把上个订单的自定义字段值带到本单（提交时随 form_extra 回写 → 串单污染）。
    editForm.resetFields();
    editForm.setFieldsValue({
      trade_date: order.trade_date,
      note: order.note ?? undefined,
      snap_game_account: snapshot?.game_account,
      snap_game_type: snapshot?.game_type ?? undefined,
      snap_game_password: snapshot?.game_password ?? undefined,
      snap_channel_region: snapshot?.channel_region ?? undefined,
      snap_bound_phone: snapshot?.bound_phone ?? undefined,
      snap_wallet_realname: snapshot?.wallet_realname ?? undefined,
      snap_camp_account: snapshot?.camp_account ?? undefined,
      snap_platform: snapshot?.platform ?? undefined,
      snap_purchase_price: snapshot?.purchase_price ?? undefined,
      snap_note: snapshot?.note ?? undefined,
      // 顺带按本单回填历史自定义字段：reset 后不能让编辑态只剩空框（旧值原本就没有回填）。
      form_extra: order.form_extra ?? {},
    });
    setEditOpen(true);
  };

  const submitEditOrder = async (values: Record<string, unknown>) => {
    if (!selectedOrder) return;
    // 成交日期现在也可改（后端联动平移账期）；hasPosted 仅用于决定账号快照是否回写。
    const orderHasPosted = (selectedOrder.events ?? []).some((event) => event.is_posted);
    setEditSubmitting(true);
    try {
      const payload = buildOrderPatchPayload({
        values,
        snapshot: selectedOrder.account_snapshot,
        hasPosted: orderHasPosted,
      });
      await ordersApi.patch(selectedOrder.id, payload);
      // 成交日期放开后，有登记事件的订单也能改主字段，统一提示「订单已更新」。
      appMessage.success("订单已更新");
      setEditOpen(false);
      setSelectedOrder(await ordersApi.get(selectedOrder.id));
      await load();
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setEditSubmitting(false);
    }
  };

  // 后端 update_order 规则：已有登记事件的订单只能改备注（orders/service.py）。
  const orderHasPostedEvents = (selectedOrder?.events ?? []).some((event) => event.is_posted);
  const legacyInitialTab = initialTab as string | undefined;
  const normalizedInitialTab: BusinessCenterTab = initialTab && ["inventory", "ledger", "collections"].includes(initialTab)
    ? initialTab
    : legacyInitialTab === "overview"
      ? "inventory"
      : initialTab
        ? "ledger"
        : DEFAULT_BUSINESS_CENTER_TAB;
  const [activeTab, setActiveTab] = useState<BusinessCenterTab>(
    normalizedInitialTab,
  );
  useEffect(() => {
    setActiveTab(normalizedInitialTab);
  }, [normalizedInitialTab]);
  const [inventoryRefreshKey, setInventoryRefreshKey] = useState(0);
  const [installmentRefreshKey, setInstallmentRefreshKey] = useState(0);


  // —— 冲销 / 取消域：分笔冲销、原路退款、分期合约取消 ——
  const cancellation = useOrderCancellation({ selectedOrder, setSelectedOrder, load });
  const {
    cancelEmployees, setCancelEmployees, cancelForm,
    cancelInstallmentTarget, setCancelInstallmentTarget,
    cancelOrderTarget, setCancelOrderTarget,
    cancelPools, setCancelPools, cancelScope, setCancelScope,
    cancelSubmitting, setCancelSubmitting,
    cancelableEventsForScope, reversibleEvents,
    closeCancelTransaction, openCancelTransaction, submitCancelTransaction,
    sharedCancellationEvent, hasSharedCancellation,
  } = cancellation;

  // —— 台账列定义域：纯展示配置 + 点击转发 ——
  const { arrangeLedgerColumns, visibleLedgerColumns } = useLedgerColumns({
    canDeleteAccount,
    openLedgerEditor,
    openAllocations,
    openProfitShare,
    openRefund,
    openOrderDelivery,
    openOrderProfile,
    openOrderRebate,
    openOrderSale,
    openOrderConsignment,
    openCancelTransaction,
    openOrderOffsale,
    openOrderDelete,
  });

  return {
    actionOrder: actionOrder,
    active: active,
    activeTab: activeTab,
    allocationCandidates: allocationCandidates,
    allocationForm: allocationForm,
    allocationIsLoss: allocationIsLoss,
    allocationMode: allocationMode,
    allocationOpen: allocationOpen,
    allocationProfit: allocationProfit,
    allocationSubmitting: allocationSubmitting,
    arrangeLedgerColumns: arrangeLedgerColumns,
    businessModeFilter: businessModeFilter,
    cancelEmployees: cancelEmployees,
    cancelForm: cancelForm,
    cancelInlineEdit: accountEditor.cancelInlineEdit,
    cancelInstallmentTarget: cancelInstallmentTarget,
    cancelOrderTarget: cancelOrderTarget,
    cancelPools: cancelPools,
    cancelScope: cancelScope,
    cancelSubmitting: cancelSubmitting,
    cancelableEventsForScope: cancelableEventsForScope,
    closeCancelTransaction: closeCancelTransaction,
    createType: createType,
    currentEmployeeId: currentEmployeeId,
    currentOperator: currentOperator,
    dateRange: dateRange,
    deliveryTarget: deliveryTarget,
    editForm: editForm,
    editOpen: editOpen,
    editSubmitting: editSubmitting,
    editingAccount: accountEditor.editingAccount,
    employeeOptions: employeeOptions,
    employees: accountEditor.employees,
    eventDrafts: accountEditor.eventDrafts,
    expandedOrderIds: expandedOrderIds,
    exportLedger: exportLedger,
    exportLedgerXlsx: exportLedgerXlsx,
    filteredOrders: filteredOrders,
    gameTypeFilter: gameTypeFilter,
    gameTypeOptions: gameTypeOptions,
    handleLedgerExpand: handleLedgerExpand,
    handleOrderOffsaleChanged: handleOrderOffsaleChanged,
    handleOrderSystemOffsale: handleOrderSystemOffsale,
    hasSharedCancellation: hasSharedCancellation,
    initialTab: initialTab,
    inlineEditId: accountEditor.inlineEditId,
    installmentRefreshKey: installmentRefreshKey,
    invEditExtraForm: accountEditor.invEditExtraForm,
    inventoryRefreshKey: inventoryRefreshKey,
    inventoryStatusFilter: inventoryStatusFilter,
    inventoryStatusOptions: inventoryStatusOptions,
    keyword: keyword,
    ledgerColumns: visibleLedgerColumns,
    ledgerDetailLoading: ledgerDetailLoading,
    ledgerDetails: ledgerDetails,
    ledgerExporting: ledgerExporting,
    ledgerSortDesc: ledgerSortDesc,
    load: load,
    loadError: loadError,
    loadLedgerDetail: loadLedgerDetail,
    loading: loading,
    onExportLedger: exportLedger,
    onExportLedgerXlsx: exportLedgerXlsx,
    onNavigate: onNavigate,
    openAllocations: openAllocations,
    openCancelTransaction: openCancelTransaction,
    openEditOrder: openEditOrder,
    openLedgerAccountEditor: openLedgerAccountEditor,
    openLedgerEditor: openLedgerEditor,
    openOrderConsignment: openOrderConsignment,
    openOrderDelete: openOrderDelete,
    openOrderDelivery: openOrderDelivery,
    openOrderOffsale: openOrderOffsale,
    openOrderRebate: openOrderRebate,
    openOrderSale: openOrderSale,
    openProfitShare: openProfitShare,
    openRefund: openRefund,
    orderBusinessModeOptions: orderBusinessModeOptions,
    orderBusinessOptions: orderBusinessOptions,
    orderConsignmentTarget: orderConsignmentTarget,
    orderDeleteSubmitting: orderDeleteSubmitting,
    orderDeleteTarget: orderDeleteTarget,
    orderHasPostedEvents: orderHasPostedEvents,
    orderOffsaleTarget: orderOffsaleTarget,
    orderRebateTarget: orderRebateTarget,
    orderSaleTarget: orderSaleTarget,
    orderTypeFilter: orderTypeFilter,
    orders: orders,
    page: page,
    pageSize: pageSize,
    profileTarget: profileTarget,
    profitRoleOptions: profitRoleOptions,
    profitShareForm: profitShareForm,
    profitShareOpen: profitShareOpen,
    profitSharePools: profitSharePools,
    profitShareSubmitting: profitShareSubmitting,
    refundForm: refundForm,
    refundOpen: refundOpen,
    refundSubmitting: refundSubmitting,
    reversibleEvents: reversibleEvents,
    saveInline: accountEditor.saveInline,
    savingAccount: accountEditor.savingAccount,
    selectedOrder: selectedOrder,
    setActionOrder: setActionOrder,
    setActiveTab: setActiveTab,
    setAllocationOpen: setAllocationOpen,
    setAllocationProfit: setAllocationProfit,
    setAllocationSubmitting: setAllocationSubmitting,
    setBusinessModeFilter: setBusinessModeFilter,
    setCancelEmployees: setCancelEmployees,
    setCancelInstallmentTarget: setCancelInstallmentTarget,
    setCancelOrderTarget: setCancelOrderTarget,
    setCancelPools: setCancelPools,
    setCancelScope: setCancelScope,
    setCancelSubmitting: setCancelSubmitting,
    setCreateType: setCreateType,
    setDateRange: setDateRange,
    setDeliveryTarget: setDeliveryTarget,
    setEditOpen: setEditOpen,
    setEditSubmitting: setEditSubmitting,
    setEditingAccount: accountEditor.setEditingAccount,
    setExpandedOrderIds: setExpandedOrderIds,
    setGameTypeFilter: setGameTypeFilter,
    setInstallmentRefreshKey: setInstallmentRefreshKey,
    setInventoryRefreshKey: setInventoryRefreshKey,
    setInventoryStatusFilter: setInventoryStatusFilter,
    setKeyword: setKeyword,
    setLedgerExporting: setLedgerExporting,
    setLedgerSortDesc: setLedgerSortDesc,
    setLoadError: setLoadError,
    setLoading: setLoading,
    setOrderConsignmentTarget: setOrderConsignmentTarget,
    setOrderDeleteTarget: setOrderDeleteTarget,
    setOrderOffsaleTarget: setOrderOffsaleTarget,
    setOrderRebateTarget: setOrderRebateTarget,
    setOrderSaleTarget: setOrderSaleTarget,
    setOrderTypeFilter: setOrderTypeFilter,
    setOrders: setOrders,
    setPage: setPage,
    setPageSize: setPageSize,
    setProfileTarget: setProfileTarget,
    setProfitShareOpen: setProfitShareOpen,
    setProfitShareSubmitting: setProfitShareSubmitting,
    setRefundOpen: setRefundOpen,
    setRefundSubmitting: setRefundSubmitting,
    setSelectedOrder: setSelectedOrder,
    setTimeShiftDays: accountEditor.setTimeShiftDays,
    setTypes: setTypes,
    setUsers: setUsers,
    sharedCancellationEvent: sharedCancellationEvent,
    submitCancelTransaction: submitCancelTransaction,
    submitEditOrder: submitEditOrder,
    submitOrderDelete: submitOrderDelete,
    submitProfitShare: submitProfitShare,
    timeShiftMinutes: accountEditor.timeShiftMinutes,
    typeCountBase: typeCountBase,
    typeNames: typeNames,
    types: types,
    updateEventDraft: accountEditor.updateEventDraft,
    users: users,
  };

}

export type OrdersPageController = ReturnType<typeof useOrdersPageController>;
