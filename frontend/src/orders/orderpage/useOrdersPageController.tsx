import { appMessage } from "../../shared/ui/appFeedback";
import { Form, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { employeesApi, installmentsApi, ordersApi, orderTypesApi, poolsApi, policyApi, stocksApi, type Account, type AccountExecutionDetail, type Installment, type Order, type OrderType, type Pool } from "../../shared/api/catalog";
import { currentDevUser, currentUser, normalizeError } from "../../shared/api/client";
import { downloadBlob } from "../../shared/api/download";
import { ACCOUNT_STATUS_LABEL, formatDateTimeMinute, formatElapsedTime, money, today } from "../../shared/lib/format";
import { filterRetiredOrderTypeOptions } from "../../shared/lib/retiredProducts";
import { useOptionSet } from "../../shared/lib/optionSets";
import { columnKey, useListViewColumns } from "../../shared/lib/listColumns";
import { useReloadOnActive } from "../../shared/state/reloadOnActive";
import { PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";
import type { BusinessOrderType } from "../CreateBusinessModal";
import type { OrderDeliveryTarget } from "../OrderDeliveryModal";
import type { InventoryProfileTarget } from "../../stocks/InventoryProfileModal";
import { DEFAULT_BUSINESS_CENTER_TAB, type BusinessCenterEntryTab, type BusinessCenterTab } from "../businessCenter";
import { BusinessFilterKey, BusinessModeFilterKey, CancelFormScope, buildActionAllocationCandidates, buildActionAllocationRows, buildOrderPatchPayload, filterBusinessOrders, formatOrderAmount, pickCancelableEvent, resolveCancelAmount, type ActionAllocationCandidates, type AllocationFormRow, type AllocationMode } from "./helpers";
import { useAccountExecutionEditor } from "../../stocks/InventoryPanel/useAccountExecutionEditor";
import { consignmentRecords, type ActiveConsignment } from "../../stocks/InventoryPlatformOffsaleModal";
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
  const [orders, setOrders] = useState<Order[]>([]);
  const [types, setTypes] = useState<OrderType[]>([]);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [mineOrders, setMineOrders] = useState(initialMine);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  // 订单台账排序：默认最新在前，可切换最旧在前（仅调展示顺序，不动接口）。
  const [ledgerSortDesc, setLedgerSortDesc] = useState(true);
  const [ledgerExporting, setLedgerExporting] = useState(false);
  const exportLedger = async () => {
    setLedgerExporting(true);
    try {
      downloadBlob(await ordersApi.exportCsv(), `订单台账-${today()}.csv`);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setLedgerExporting(false);
    }
  };
  /** 导出 Excel：5 个 sheet（主订单 + 详情 + 操作/资金/返点三类明细），表头为合并单元格。 */
  const exportLedgerXlsx = async () => {
    setLedgerExporting(true);
    try {
      downloadBlob(await ordersApi.exportXlsx(), `订单台账-${today()}.xlsx`);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setLedgerExporting(false);
    }
  };
  const [orderTypeFilter, setOrderTypeFilter] = useState<BusinessFilterKey>("all");
  const [businessModeFilter, setBusinessModeFilter] = useState<BusinessModeFilterKey>("all");
  const [gameTypeFilter, setGameTypeFilter] = useState("all");
  const [inventoryStatusFilter, setInventoryStatusFilter] = useState("all");
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  // 业务类型、业务模式、责任方和关联关系均来自后端选项词典。
  type Opt = { value: string; label: string };
  const orderBusinessOptions: Opt[] = filterRetiredOrderTypeOptions(useOptionSet("ORDER_BUSINESS") ?? []);
  const refundResponsibilityOptions: Opt[] = useOptionSet("REFUND_RESPONSIBILITY") ?? [];
  const orderBusinessModeOptions: Opt[] = useOptionSet("ORDER_BUSINESS_MODE") ?? [];
  const relationTypeOptions: Opt[] = useOptionSet("ORDER_RELATION_TYPE") ?? [];
  const profitRoleOptions: Opt[] = useOptionSet("PROFIT_ROLE") ?? [];
  const inventoryStatusOptions: Opt[] = [
    { value: "all", label: "全部库存状态" },
    ...(["WAITING", "SOLD", "VOID"] as const).map((value) => ({ value, label: ACCOUNT_STATUS_LABEL[value] })),
  ];
  const gameTypeOptions = useMemo(() => {
    const values = Array.from(new Set(orders.map((order) => order.account_game_type).filter((value): value is string => Boolean(value))))
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
    return [{ value: "all", label: "全部游戏类型" }, ...values.map((value) => ({ value, label: value }))];
  }, [orders]);
  const [keyword, setKeyword] = useState("");
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
  const [cancelOrderTarget, setCancelOrderTarget] = useState<Order | null>(null);
  const [cancelInstallmentTarget, setCancelInstallmentTarget] = useState<Installment | null>(null);
  const [cancelScope, setCancelScope] = useState<CancelFormScope>("ORDERCANC");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelPools, setCancelPools] = useState<Pool[]>([]);
  const [cancelEmployees, setCancelEmployees] = useState<Array<{ id: number; username: string; display_name: string; is_active: boolean }>>([]);
  const [cancelForm] = Form.useForm();
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, typeList] = await Promise.all([
        ordersApi.list(mineOrders ? { mine: true } : undefined),
        orderTypesApi.list(),
      ]);
      setOrders(list);
      setTypes(typeList);
      setLoadError(null);
    } catch (error) {
      setLoadError(normalizeError(error));
    } finally {
      setLoading(false);
    }
  }, [mineOrders]);

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
        category: "REFUND",
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

  /**
   * 可冲销动作：已过账的 BUY/SELL，按「剩余可冲金额」过滤（后端支持部分冲销）。
   * 余额由后端 `event.cancellable_amount` 下发，前端只负责挑哪一条、按什么顺序 -
   * 不再自己遍历 CANCEL 事件做 `amount − Σcancel`（那是与库存页、提交校验并行的第三套。
   */
  const reversibleEvents = (order: Order | null) => {
    return (order?.events ?? [])
      .filter((event) => event.is_posted && ["BUY", "SELL"].includes(event.event_type))
      .map((event) => ({ event, remaining: event.cancellable_amount ?? "0.00" }))
      .filter((item) => Number(item.remaining) > 0)
      .reverse();
  };

  const cancelableEventsForScope = (order: Order | null, scope: CancelFormScope) => reversibleEvents(order)
    .filter(({ event }) => scope === "INVREFUND"
      ? event.event_type === "BUY"
      : event.event_type === "SELL");

  const openCancelTransaction = async (sourceOrder?: Order) => {
    try {
      const order = sourceOrder ? await ordersApi.get(sourceOrder.id) : selectedOrder;
      if (!order) return;
      if (order.installment_principal) {
        const contracts = await installmentsApi.list({ order_id: order.id });
        const target = contracts.find((item) => !["CANCELLED", "DELIVERED"].includes(item.status));
        if (!target) {
          appMessage.error("未找到可取消的分期合约");
          return;
        }
        setCancelInstallmentTarget(target);
        setCancelOrderTarget(null);
      } else {
        // 取消弹窗依赖资金账户和操作人主数据；先准备完整上下文，再打开弹窗，
        // 避免用户在下拉尚未加载时确认导致无请求、无结果的“假提交”。
        const reversible = reversibleEvents(order);
        const first = reversible[0];
        const nextScope: CancelFormScope = first?.event.event_type === "BUY" ? "INVREFUND" : "ORDERCANC";
        cancelForm.setFieldsValue({
          cancelled_on: today(),
          offset_event_id: first?.event.id,
          [nextScope === "INVREFUND" ? "refund_amount" : "cancel_amount"]: first?.remaining,
          pool_id: first?.event.pool_id ?? undefined,
        });
        const [poolList, employeeList] = await Promise.all([poolsApi.list(), employeesApi.list()]);
        const activeEmployees = employeeList.filter((employee) => employee.is_active);
        setCancelPools(poolList.filter((pool) => pool.status === "ACTIVE"));
        setCancelEmployees(activeEmployees);
        // 先在打开弹窗的加载阶段写入默认操作人，避免依赖 ResponsibleEmployeeSelect
        // 内部的 /auth/me 异步回填；提交动作必须始终携带显式员工 ID。
        if (cancelForm.getFieldValue("operator_user_ids") == null) {
          const defaultEmployee = activeEmployees.find((employee) => employee.username === currentOperator)
            ?? (activeEmployees.length === 1 ? activeEmployees[0] : undefined);
          if (defaultEmployee) cancelForm.setFieldValue("operator_user_ids", [defaultEmployee.id]);
        }
        if (first && cancelForm.getFieldValue("pool_id") == null) {
          cancelForm.setFieldValue("pool_id", poolList[0]?.id);
        }
        setCancelScope(nextScope);
        setCancelOrderTarget(order);
        setCancelInstallmentTarget(null);
      }
      if (order.installment_principal) cancelForm.setFieldsValue({ cancelled_on: today() });
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const closeCancelTransaction = () => {
    setCancelOrderTarget(null);
    setCancelInstallmentTarget(null);
    setCancelScope("ORDERCANC");
    cancelForm.resetFields();
  };

  const submitCancelTransaction = async (values: { cancelled_on: string; reason: string; offset_event_id?: number; amount?: string; cancel_amount?: string; refund_amount?: string; pool_id?: number; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) => {
    const installment = cancelInstallmentTarget;
    const order = cancelOrderTarget;
    if (!installment && !order) return;
    setCancelSubmitting(true);
    try {
      if (installment) {
        const result = await installmentsApi.cancel(installment.id, values);
        const refundSummary = `退款已登记：¥${money(result.refund_amount)}`;
        appMessage.success(
          installment.contract_type === "PICKUP_SALE"
            ? `${refundSummary}，提号交易已结束`
            : `${refundSummary}，账号已回到库存`,
        );
        if (result.order_status === "CANCELLED") await load();
      } else {
        if (!order) return;
        const reversible = cancelableEventsForScope(order, cancelScope);
        const selected = pickCancelableEvent(reversible, values.offset_event_id);
        if (selected) {
          const resolved = resolveCancelAmount({ scope: cancelScope, values, remaining: selected.remaining });
          if (!resolved.ok) {
            appMessage.error(resolved.error);
            return;
          }
          const amount = resolved.amount;
          // 操作人是业务事实的一部分，不能依赖异步下拉组件恰好先完成默认值注入。
          // 用户直接确认弹窗时，最后一次从当前会话解析员工 ID，确保后端收到显式负责人。
          let operatorUserIds = values.operator_user_ids?.length ? values.operator_user_ids : undefined;
          if (!operatorUserIds?.length) {
            const byDevUser = cancelEmployees.find((employee) => employee.username === currentOperator);
            if (byDevUser) operatorUserIds = [byDevUser.id];
            else if (cancelEmployees.length === 1) operatorUserIds = [cancelEmployees[0].id];
            else if (cancelEmployees.length > 0) {
              try {
                const current = await currentUser();
                const bySessionUser = cancelEmployees.find((employee) => employee.id === current.id || employee.username === current.username);
                if (bySessionUser) operatorUserIds = [bySessionUser.id];
              } catch {
                // 下拉组件已尝试默认当前员工；解析失败时保留空值，让后端按必填规则返回明确错误。
              }
            }
          }
          const result = await ordersApi.postEvent(order.id, {
            event_type: "CANCEL",
            amount,
            occurred_on: values.cancelled_on,
            offset_event_id: selected.event.id,
            pool_id: Number(values.pool_id),
            operator_user_ids: operatorUserIds,
            reason: values.reason,
            note: cancelScope === "INVREFUND" ? "取消：冲销入库并入账" : "取消：原路退款",
            form_extra_scope: cancelScope,
            form_extra: values.form_extra,
          });
          appMessage.success(cancelScope === "INVREFUND"
            ? `取消已登记：入账 ¥${money(result.event.amount)}，已进入公司钱包`
            : `取消已登记：退款 ¥${money(result.event.amount)}，已按原资金池退还客户`);
        } else {
          await ordersApi.cancel(order.id, { reason: values.reason, form_extra: values.form_extra });
          appMessage.success("交易已取消，无已登记款项需要退款");
        }
        await load();
      }
      closeCancelTransaction();
      setSelectedOrder(null);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setCancelSubmitting(false);
    }
  };

  /** 编辑订单：后端限制——已有登记事件的订单只能改备注；账号快照仅特定业务可维护，
   *  且密码被后端隐去（无 order.create 权限）时不允许整体回写快照，避免覆盖隐藏密码。 */
  const openEditOrder = (order: Order) => {
    setSelectedOrder(order);
    const snapshot = order.account_snapshot;
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

  // keep-alive：切走再切回不会重挂载。重新激活（active 翻回 true）时重拉列表，
  // 保证在其他入口新建的订单（工作台快捷建单、库存中心售出/寄售/返点）的订单号及时出现在台账。
  useReloadOnActive(active, load);
  useEffect(() => {
    if (active) setMineOrders(initialMine);
  }, [active, initialMine]);

  const typeNames = Object.fromEntries(types.map((type) => [type.code, type.name]));
  // 先按业务筛选，再按日期，最后一次排序；避免渲染层重复计算同一批订单。
  const filteredOrders = filterBusinessOrders(orders, orderTypeFilter, businessModeFilter, keyword, gameTypeFilter, inventoryStatusFilter)
    .filter((order) => {
      if (!dateRange) return true;
      const tradeDate = new Date(`${order.trade_date}T00:00:00`);
      return !Number.isNaN(tradeDate.getTime())
        && tradeDate >= dateRange[0].startOf("day").toDate()
        && tradeDate <= dateRange[1].endOf("day").toDate();
    })
    .slice()
    .sort((a, b) => (ledgerSortDesc ? b.id - a.id : a.id - b.id));
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

  const { arrange: arrangeLedgerColumns } = useListViewColumns("LEDGER");
  const ledgerColumns: ColumnsType<Order> = [
    { title: "订单号", dataIndex: "order_no", width: 110, ellipsis: true },
    { title: "游戏/产品类型", dataIndex: "account_game_type", width: 140, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "游戏账号/产品", dataIndex: "account_game_account", width: 140, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "入库负责人", dataIndex: "inventory_operator", width: 110, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "入库时间", dataIndex: "inventory_entry_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "售卖负责人", dataIndex: "sale_operator", width: 110, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "售卖时间", dataIndex: "sale_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "在手时间", key: "in_hand_time", width: 120, ellipsis: true, render: (_v, order) => order.in_hand_time ?? formatElapsedTime(order.inventory_entry_at, order.sale_at) },
    { title: "金额", dataIndex: "event_total", width: 126, ellipsis: true, render: (_v: string | null, order) => formatOrderAmount(order) },
    { title: "订单状态", dataIndex: "status", width: 96, ellipsis: true, render: (v: string) => <StatusTag status={v} optionSet="ORDER_STATUS" /> },
    { title: "库存状态", dataIndex: "account_status", width: 102, ellipsis: true, render: (v: string | null) => v ? <StatusTag status={v} label={ACCOUNT_STATUS_LABEL[v] ?? v} /> : "-" },
    { title: "成本", dataIndex: "cost_amount", width: 110, ellipsis: true, render: (_v: string | null, order) => order.account_status === "SOLD" && order.cost_amount != null ? `¥${money(order.cost_amount)}` : "-" },
    { title: "利润", dataIndex: "profit_base", width: 110, ellipsis: true, render: (_v: string | null, order) => order.account_status === "SOLD" && order.profit_base != null ? `¥${money(order.profit_base)}` : "-" },
    { title: "日期", dataIndex: "trade_date", width: 144, ellipsis: true },
    {
      title: "操作",
      key: "actions",
      width: 470,
      ellipsis: true,
      render: (_, order) => {
        const canOffsaleConsignment = order.order_type === "DG" && order.status === "ACTIVE" && order.account_status === "WAITING";
        return (
          <Space size={2}>
          {order.account_id || ["ACTIVE", "INSTALLMENT"].includes(order.status) ? (
            <PermissionButton
              permission="order.update"
              type="link"
              size="small"
              title={order.account_id ? undefined : "未关联库存时会先生成库存编号"}
              onClick={() => void openLedgerEditor(order)}
            >编辑</PermissionButton>
          ) : null}
          <PermissionGate permission="order.event.post">
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              onClick={() => void openAllocations(order)}
            >分润配置</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              onClick={() => void openProfitShare(order)}
            >分润</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              onClick={() => void openRefund(order)}
            >资金收支</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={order.status === "CANCELLED"}
              onClick={() => void openOrderDelivery(order)}
            >交付</PermissionButton>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              disabled={!order.account_id || order.status === "CANCELLED"}
              onClick={() => void openOrderProfile(order, "description")}
            >描述</PermissionButton>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              disabled={!order.account_id || order.status === "CANCELLED"}
              onClick={() => void openOrderProfile(order, "images")}
            >作图</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!order.account_id}
              onClick={() => void openOrderRebate(order)}
            >返点</PermissionButton>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              disabled={order.account_status !== "WAITING" || !order.account_id}
              onClick={() => void openOrderSale(order)}
            >售出</PermissionButton>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              disabled={order.account_status !== "WAITING" || !order.account_id}
              onClick={() => void openOrderConsignment(order)}
            >寄售</PermissionButton>
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              danger
              disabled={!['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              onClick={() => {
                if (canOffsaleConsignment) void openOrderOffsale(order);
                else void openCancelTransaction(order);
              }}
            >{canOffsaleConsignment ? "下架" : "取消"}</PermissionButton>
          </PermissionGate>
          {canDeleteAccount ? (
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              danger
              disabled={!order.account_id}
              onClick={() => void openOrderDelete(order)}
            >删除账号</PermissionButton>
          ) : null}
        </Space>
        );
      },
    },
  ];
  const configuredLedgerColumns = arrangeLedgerColumns(ledgerColumns);
  const ledgerDateColumn = ledgerColumns.find((column) => columnKey(column) === "trade_date");
  // 日期是订单台账的核心识别字段，避免配置中心误隐藏后整列消失。
  const visibleLedgerColumns = ledgerDateColumn && !configuredLedgerColumns.some((column) => columnKey(column) === "trade_date")
    ? [
        ...configuredLedgerColumns.filter((column) => columnKey(column) !== "actions"),
        ledgerDateColumn,
        ...configuredLedgerColumns.filter((column) => columnKey(column) === "actions"),
      ]
    : configuredLedgerColumns;
  const sharedCancellationEvent = cancelOrderTarget
    ? cancelableEventsForScope(cancelOrderTarget, cancelScope)[0]
    : undefined;
  const hasSharedCancellation = Boolean(sharedCancellationEvent);


  return {
    active,
    initialTab,
    onNavigate,
    actionOrder,
    activeTab,
    allocationCandidates,
    allocationForm,
    allocationIsLoss,
    allocationMode,
    allocationOpen,
    allocationProfit,
    allocationSubmitting,
    arrangeLedgerColumns,
    businessModeFilter,
    dateRange,
    cancelEmployees,
    cancelForm,
    cancelInstallmentTarget,
    cancelOrderTarget,
    cancelPools,
    cancelScope,
    cancelSubmitting,
    cancelableEventsForScope,
    closeCancelTransaction,
    createType,
    currentEmployeeId,
    currentOperator,
    editForm,
    editOpen,
    editSubmitting,
    employeeOptions,
    expandedOrderIds,
    exportLedger,
    exportLedgerXlsx,
    onExportLedger: exportLedger,
    onExportLedgerXlsx: exportLedgerXlsx,
    filteredOrders,
    gameTypeFilter,
    gameTypeOptions,
    handleLedgerExpand,
    hasSharedCancellation,
    installmentRefreshKey,
    inventoryRefreshKey,
    inventoryStatusFilter,
    inventoryStatusOptions,
    keyword,
    ledgerExporting,
    ledgerDetailLoading,
    ledgerDetails,
    editingAccount: accountEditor.editingAccount,
    setEditingAccount: accountEditor.setEditingAccount,
    inlineEditId: accountEditor.inlineEditId,
    eventDrafts: accountEditor.eventDrafts,
    updateEventDraft: accountEditor.updateEventDraft,
    employees: accountEditor.employees,
    timeShiftMinutes: accountEditor.timeShiftMinutes,
    setTimeShiftDays: accountEditor.setTimeShiftDays,
    invEditExtraForm: accountEditor.invEditExtraForm,
    savingAccount: accountEditor.savingAccount,
    cancelInlineEdit: accountEditor.cancelInlineEdit,
    saveInline: accountEditor.saveInline,
    ledgerSortDesc,
    load,
    loadError,
    loadLedgerDetail,
    loading,
    openAllocations,
    openLedgerAccountEditor,
    openLedgerEditor,
    openCancelTransaction,
    openEditOrder,
    openProfitShare,
    openOrderDelete,
    openOrderDelivery,
    openOrderOffsale,
    openOrderRebate,
    openOrderSale,
    openOrderConsignment,
    openRefund,
    handleOrderOffsaleChanged,
    handleOrderSystemOffsale,
    orderHasPostedEvents,
    orderTypeFilter,
    orders,
    page,
    pageSize,
    profitShareForm,
    profitShareOpen,
    profitSharePools,
    profitShareSubmitting,
    orderRebateTarget,
    orderSaleTarget,
    orderConsignmentTarget,
    orderDeleteTarget,
    orderDeleteSubmitting,
    deliveryTarget,
    profileTarget,
    orderOffsaleTarget,
    submitOrderDelete,
    setOrderRebateTarget,
    setOrderSaleTarget,
    setOrderConsignmentTarget,
    setOrderDeleteTarget,
    setDeliveryTarget,
    setProfileTarget,
    setOrderOffsaleTarget,
    refundForm,
    refundOpen,
    refundSubmitting,
    reversibleEvents,
    selectedOrder,
    setActionOrder,
    setActiveTab,
    setAllocationOpen,
    setAllocationProfit,
    setAllocationSubmitting,
    setBusinessModeFilter,
    setDateRange,
    setCancelEmployees,
    setCancelInstallmentTarget,
    setCancelOrderTarget,
    setCancelPools,
    setCancelScope,
    setCancelSubmitting,
    setCreateType,
    setEditOpen,
    setEditSubmitting,
    setExpandedOrderIds,
    setInstallmentRefreshKey,
    setInventoryRefreshKey,
    setKeyword,
    setGameTypeFilter,
    setInventoryStatusFilter,
    setLedgerExporting,
    setLedgerSortDesc,
    setLoadError,
    setLoading,
    setOrderTypeFilter,
    setOrders,
    setPage,
    setPageSize,
    setProfitShareOpen,
    setProfitShareSubmitting,
    setRefundOpen,
    setRefundSubmitting,
    setSelectedOrder,
    setTypes,
    setUsers,
    sharedCancellationEvent,
    submitCancelTransaction,
    submitEditOrder,
    submitProfitShare,
    typeNames,
    types,
    users,
    ledgerColumns: visibleLedgerColumns,
    orderBusinessOptions,
    orderBusinessModeOptions,
    profitRoleOptions,
  };
}

export type OrdersPageController = ReturnType<typeof useOrdersPageController>;
