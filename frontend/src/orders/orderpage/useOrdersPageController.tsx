import { appMessage } from "../../shared/ui/appFeedback";
import { Form, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { employeesApi, installmentsApi, ordersApi, orderTypesApi, poolsApi, policyApi, stocksApi, type AccountExecutionDetail, type Installment, type Order, type OrderType, type Pool } from "../../shared/api/catalog";
import { currentDevUser, currentUser, normalizeError } from "../../shared/api/client";
import { downloadBlob } from "../../shared/api/download";
import { ACCOUNT_STATUS_LABEL, formatDateTimeMinute, formatElapsedTime, money, today } from "../../shared/lib/format";
import { filterRetiredOrderTypeOptions } from "../../shared/lib/retiredProducts";
import { useOptionSet } from "../../shared/lib/optionSets";
import { columnKey, useListViewColumns } from "../../shared/lib/listColumns";
import { useReloadOnActive } from "../../shared/state/reloadOnActive";
import { PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";
import type { BusinessOrderType } from "../CreateBusinessModal";
import { DEFAULT_BUSINESS_CENTER_TAB, type BusinessCenterEntryTab, type BusinessCenterTab } from "../businessCenter";
import { BusinessFilterKey, BusinessModeFilterKey, CancelFormScope, buildActionAllocationCandidates, buildActionAllocationRows, filterBusinessOrders, formatOrderAmount, pickCancelableEvent, resolveCancelAmount, type ActionAllocationCandidates, type AllocationFormRow, type AllocationMode } from "./helpers";
import { useOrderEditor } from "../orderedit";

export function useOrdersPageController(params: {
  active?: boolean;
  initialTab?: BusinessCenterEntryTab;
  initialMine?: boolean;
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
} = {}) {
  const { active = true, initialTab, initialMine = false, onNavigate } = params;
  const currentOperator = currentDevUser();
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
  const orderBusinessModeOptions: Opt[] = useOptionSet("ORDER_BUSINESS_MODE") ?? [];
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
  const orderEditor = useOrderEditor({
    getExecutionDetail: (id) => ledgerDetails[id],
    onSaved: (id, detail) => setLedgerDetails((current) => ({ ...current, [id]: detail })),
  });

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
      refundForm.setFieldValue("pool_id", activePools[0]?.id);
      setRefundOpen(true);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  /**
   * 可冲销动作：已过账的 BUY/COST/SELL，按「剩余可冲金额」过滤（后端支持部分冲销）。
   * 余额由后端 `event.cancellable_amount` 下发，前端只负责挑哪一条、按什么顺序 -
   * 不再自己遍历 CANCEL 事件做 `amount − Σcancel`（那是与库存页、提交校验并行的第三套。
   */
  const reversibleEvents = (order: Order | null) => {
    return (order?.events ?? [])
      .filter((event) => event.is_posted && ["BUY", "COST", "SELL"].includes(event.event_type))
      .map((event) => ({ event, remaining: event.cancellable_amount ?? "0.00" }))
      .filter((item) => Number(item.remaining) > 0)
      .reverse();
  };

  const cancelableEventsForScope = (order: Order | null, scope: CancelFormScope) => reversibleEvents(order)
    .filter(({ event }) => scope === "INVREFUND"
      ? ["BUY", "COST"].includes(event.event_type)
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
        const nextScope: CancelFormScope = first && ["BUY", "COST"].includes(first.event.event_type) ? "INVREFUND" : "ORDERCANC";
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

  const openSystemOffsale = () => {
    setActiveTab("inventory");
    setSelectedOrder(null);
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

  /** 订单台账编辑：与库存中心使用同一份完整详情编辑态，删除订单级小窗，避免一行出现两套编辑模型。 */
  const openAccountEditor = async (order: Order) => {
    if (!order.account_id) return;
    try {
      const detail = await stocksApi.executionDetail(order.account_id);
      setLedgerDetails((current) => ({ ...current, [order.account_id as number]: detail }));
      await orderEditor.openEditor(detail.account, detail);
      setExpandedOrderIds([String(order.id)]);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  // 页面重新激活时重拉列表，保证在其他入口新建的订单（工作台快捷建单、库存中心售出/寄售/返点）
  // 的订单号及时出现在台账。
  useReloadOnActive(active, load);
  useEffect(() => {
    if (active) setMineOrders(initialMine);
  }, [active, initialMine]);

  const typeNames = useMemo(() => Object.fromEntries(types.map((type) => [type.code, type.name])), [types]);
  const filteredOrders = useMemo(() => {
    // 先按业务筛选，再按日期，最后一次排序；避免无关状态变化时重复扫描订单。
    const startTime = dateRange?.[0].startOf("day").valueOf();
    const endTime = dateRange?.[1].endOf("day").valueOf();
    return filterBusinessOrders(orders, orderTypeFilter, businessModeFilter, keyword, gameTypeFilter, inventoryStatusFilter)
      .filter((order) => {
        if (startTime === undefined || endTime === undefined) return true;
        const tradeTime = new Date(`${order.trade_date}T00:00:00`).getTime();
        return !Number.isNaN(tradeTime) && tradeTime >= startTime && tradeTime <= endTime;
      })
      .slice()
      .sort((a, b) => (ledgerSortDesc ? b.id - a.id : a.id - b.id));
  }, [businessModeFilter, dateRange, gameTypeFilter, inventoryStatusFilter, keyword, ledgerSortDesc, orderTypeFilter, orders]);
  const normalizedInitialTab: BusinessCenterTab = initialTab && ["inventory", "ledger", "collections"].includes(initialTab)
    ? initialTab
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
      width: 220,
      ellipsis: true,
      render: (_, order) => {
        const canOffsaleConsignment = order.order_type === "DG" && order.status === "ACTIVE" && order.account_status === "WAITING";
        return (
          <Space size={2}>
          {order.account_id ? (
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              disabled={orderEditor.editingAccount !== null}
              onClick={() => void openAccountEditor(order)}
            >
              编辑
            </PermissionButton>
          ) : null}
          <PermissionGate permission="order.event.post">
            <PermissionButton
              permission="order.event.post"
              type="link"
              size="small"
              disabled={!['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              onClick={() => void openAllocations(order)}
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
              danger
              disabled={!['ACTIVE', 'INSTALLMENT', 'COMPLETED'].includes(order.status)}
              onClick={() => {
                if (canOffsaleConsignment) openSystemOffsale();
                else void openCancelTransaction(order);
              }}
            >{canOffsaleConsignment ? "下架" : "取消"}</PermissionButton>
          </PermissionGate>
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
    editingAccount: orderEditor.editingAccount,
    setEditingAccount: orderEditor.setEditingAccount,
    inlineEditId: orderEditor.inlineEditId,
    eventDrafts: orderEditor.eventDrafts,
    updateEventDraft: orderEditor.updateEventDraft,
    timeDrafts: orderEditor.timeDrafts,
    updateTimeDraft: orderEditor.updateTimeDraft,
    orderDrafts: orderEditor.orderDrafts,
    updateOrderDraft: orderEditor.updateOrderDraft,
    partyDrafts: orderEditor.partyDrafts,
    updatePartyDraft: orderEditor.updatePartyDraft,
    employees: orderEditor.employees,
    orderEditExtraForm: orderEditor.orderEditExtraForm,
    savingAccount: orderEditor.savingAccount,
    openAccountEditor,
    cancelInlineEdit: orderEditor.cancelInlineEdit,
    saveInline: orderEditor.saveInline,
    ledgerSortDesc,
    load,
    loadError,
    loadLedgerDetail,
    loading,
    openAllocations,
    openCancelTransaction,
    openRefund,
    openSystemOffsale,
    orderTypeFilter,
    orders,
    page,
    pageSize,
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
    setRefundOpen,
    setRefundSubmitting,
    setSelectedOrder,
    setTypes,
    setUsers,
    sharedCancellationEvent,
    submitCancelTransaction,
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
