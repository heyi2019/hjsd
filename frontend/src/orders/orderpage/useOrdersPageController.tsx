import { appMessage } from "../../shared/ui/appFeedback";
import { Dropdown, Form, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { employeesApi, installmentsApi, ordersApi, orderTypesApi, poolsApi, policyApi, stocksApi, type AccountExecutionDetail, type Installment, type Order, type OrderType, type Pool } from "../../shared/api/catalog";
import { currentDevUser, currentUser, normalizeError } from "../../shared/api/client";
import { downloadBlob } from "../../shared/api/download";
import { ACCOUNT_STATUS_LABEL, executionActionLabel, formatDateTimeMinute, formatElapsedTime, money, today } from "../../shared/lib/format";
import { filterRetiredOrderTypeOptions } from "../../shared/lib/retiredProducts";
import { useOptionSet } from "../../shared/lib/optionSets";
import { columnKey, useListViewColumns } from "../../shared/lib/listColumns";
import { useReloadOnActive } from "../../shared/state/reloadOnActive";
import { PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";
import type { BusinessOrderType } from "../CreateBusinessModal";
import { DEFAULT_BUSINESS_CENTER_TAB, type BusinessCenterEntryTab, type BusinessCenterTab } from "../businessCenter";
import { BusinessFilterKey, BusinessModeFilterKey, CancelFormScope, filterBusinessOrders, formatOrderAmount } from "./helpers";

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
  const loadLedgerDetail = async (accountId: number) => {
    if (ledgerDetails[accountId] || ledgerDetailLoading[accountId]) return;
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
      setActionOrder(order);
      setUsers(userResult.filter((item) => item.is_active));
      setAllocationProfit(result.order_profit ?? "0");
      // 分润按「姓名」录入：存量行直接映射成姓名（COMPANY / 无收益人 → 公司归属），
      // 不再暴露 BUY/SELL/OPERATION/COMPANY 四个动作位——那种结构只允许一人拿运营份额。
      // 角色必须原样带回表单：不回填就会在保存时被默认值 OWNER 覆盖掉。
      const rows = result.items.map((item) => ({
        employee: (item.user_id ?? "COMPANY") as number | "COMPANY",
        role: item.role || "OWNER",
        allocation_rate: item.allocation_rate,
        allocation_amount: item.allocation_amount ?? "",
      }));
      allocationForm.setFieldsValue({
        allocations: rows.length > 0 ? rows : [{ employee: undefined, role: "OWNER", allocation_rate: "", allocation_amount: "" }],
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
      const employeeList = await employeesApi.list();
      setUsers(employeeList.filter((employee) => employee.is_active));
      setActionOrder(order);
      refundForm.resetFields();
      setRefundOpen(true);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  /** 可冲销动作：已过账的 BUY/COST/SELL，按剩余可冲金额过滤（后端支持部分冲销）。 */
  const reversibleEvents = (order: Order | null) => {
    const posted = (order?.events ?? []).filter((event) => event.is_posted);
    const cancelled = new Map<number, number>();
    for (const event of posted) {
      if (event.event_type !== "CANCEL" || event.offset_event_id == null) continue;
      cancelled.set(event.offset_event_id, (cancelled.get(event.offset_event_id) ?? 0) + Number(event.amount || 0));
    }
    return posted
      .filter((event) => ["BUY", "COST", "SELL"].includes(event.event_type))
      .map((event) => {
        const remaining = Number(event.amount || 0) - (cancelled.get(event.id) ?? 0);
        return { event, remaining };
      })
      .filter((item) => item.remaining > 0)
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
        setCancelOrderTarget(order);
        setCancelInstallmentTarget(null);
        // 先把基础日期和默认冲销动作写入表单，账户/操作人异步加载时弹窗仍可正常提交。
        const reversible = reversibleEvents(order);
        const first = reversible[0];
        const nextScope: CancelFormScope = first && ["BUY", "COST"].includes(first.event.event_type) ? "INVREFUND" : "ORDERCANC";
        setCancelScope(nextScope);
        cancelForm.setFieldsValue({
          cancelled_on: today(),
          offset_event_id: first?.event.id,
          [nextScope === "INVREFUND" ? "refund_amount" : "cancel_amount"]: first ? first.remaining.toFixed(2) : undefined,
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
        const selected = reversible.find((item) => item.event.id === Number(values.offset_event_id)) ?? reversible[0];
        if (selected) {
          const amountValue = cancelScope === "INVREFUND" ? (values.refund_amount ?? values.amount) : (values.cancel_amount ?? values.amount);
          const amount = (amountValue ?? "").trim() || selected.remaining.toFixed(2);
          if (Number.isNaN(Number(amount)) || Number(amount) <= 0) {
            appMessage.error("请输入有效的冲销金额");
            return;
          }
          if (Number(amount) > selected.remaining + 1e-9) {
            appMessage.error(`冲销金额不能超过该动作剩余可冲金额 ¥${selected.remaining.toFixed(2)}`);
            return;
          }
          // 操作人是业务事实的一部分，不能依赖异步下拉组件恰好先完成默认值注入。
          // 用户直接确认弹窗时，最后一次从当前会话解析员工 ID，确保后端收到显式负责人。
          let operatorUserIds = values.operator_user_ids?.length ? values.operator_user_ids : undefined;
          if (!operatorUserIds?.length) {
            const byDevUser = cancelEmployees.find((employee) => employee.username === currentOperator);
            if (byDevUser) operatorUserIds = [byDevUser.id];
            else if (cancelEmployees.length === 1) operatorUserIds = [cancelEmployees[0].id];
            else {
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
            note: cancelScope === "INVREFUND" ? "库存取消交易，冲销入库并入账" : "售出取消交易，原路退款",
            form_extra_scope: cancelScope,
            form_extra: values.form_extra,
          });
          appMessage.success(cancelScope === "INVREFUND"
            ? `库存取消交易已登记：入账 ¥${money(result.event.amount)}，已进入公司钱包`
            : `售出取消交易已登记：退款 ¥${money(result.event.amount)}，已按原资金池退还客户`);
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
      snap_platform: snapshot?.platform ?? undefined,
      snap_purchase_price: snapshot?.purchase_price ?? undefined,
      snap_note: snapshot?.note ?? undefined,
    });
    setEditOpen(true);
  };

  const submitEditOrder = async (values: Record<string, unknown>) => {
    if (!selectedOrder) return;
    // 后端规则：已有登记事件的订单只能改备注（核算字段必须走冲销/更正）。
    const orderHasPosted = (selectedOrder.events ?? []).some((event) => event.is_posted);
    setEditSubmitting(true);
    try {
      const payload: Parameters<typeof ordersApi.patch>[1] = {};
      if (!orderHasPosted) payload.trade_date = values.trade_date as string;
      payload.note = (values.note as string | undefined)?.trim() ? (values.note as string).trim() : null;
      payload.form_extra = (values.form_extra as Record<string, unknown> | undefined) ?? undefined;
      const snapshot = selectedOrder.account_snapshot;
      // 仅当快照密码可见（持有 order.create）时才允许整体回写，防止把隐藏密码覆盖为空。
      if (!orderHasPosted && snapshot && snapshot.game_password) {
        payload.account_snapshot = {
          game_account: (values.snap_game_account as string) ?? snapshot.game_account,
          game_type: (values.snap_game_type as string) || null,
          game_password: (values.snap_game_password as string) || null,
          channel_region: (values.snap_channel_region as string) || null,
          bound_phone: (values.snap_bound_phone as string) || null,
          platform: (values.snap_platform as string) || null,
          purchase_price: (values.snap_purchase_price as string) || null,
          note: (values.snap_note as string) || null,
        };
      }
      await ordersApi.patch(selectedOrder.id, payload);
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
  const [activeTab, setActiveTab] = useState<BusinessCenterTab>(
    initialTab === "inventory" ? "inventory" : DEFAULT_BUSINESS_CENTER_TAB,
  );
  const [inventoryRefreshKey, setInventoryRefreshKey] = useState(0);
  const [installmentRefreshKey, setInstallmentRefreshKey] = useState(0);

  const { arrange: arrangeLedgerColumns } = useListViewColumns("LEDGER");
  const ledgerColumns: ColumnsType<Order> = [
    { title: "订单号", dataIndex: "order_no", width: 110, ellipsis: true },
    { title: "对方 / 来源", key: "party", width: 160, ellipsis: true, render: (_, order) => [order.party_name, order.party_source].filter(Boolean).join(" · ") || "-" },
    { title: "游戏/产品类型", dataIndex: "account_game_type", width: 140, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "游戏账号/产品", dataIndex: "account_game_account", width: 140, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "平台", dataIndex: "account_platform", width: 72, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "入库负责人", dataIndex: "inventory_operator", width: 110, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "入库时间", dataIndex: "inventory_entry_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "售卖负责人", dataIndex: "sale_operator", width: 110, ellipsis: true, render: (v: string | null) => v || "-" },
    { title: "售卖时间", dataIndex: "sale_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "在手时间", key: "in_hand_time", width: 120, ellipsis: true, render: (_v, order) => formatElapsedTime(order.inventory_entry_at, order.sale_at) },
    { title: "金额", dataIndex: "event_total", width: 126, ellipsis: true, render: (_v: string | null, order) => formatOrderAmount(order) },
    { title: "账号周期", dataIndex: "account_status", width: 102, ellipsis: true, render: (v: string | null) => v ? <StatusTag status={v} label={ACCOUNT_STATUS_LABEL[v] ?? v} /> : "-" },
    { title: "最新动作", dataIndex: "last_event_type", width: 198, ellipsis: true, render: (v: string | null, order) => v ? `${executionActionLabel(v, order.order_type)}${order.last_event_amount ? ` · ¥${order.last_event_amount}` : ""}` : "-" },
    { title: "状态", dataIndex: "status", width: 111, ellipsis: true, render: (v: string) => <StatusTag status={v} optionSet="ORDER_STATUS" /> },
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
          <PermissionButton permission="order.update" type="link" onClick={() => openEditOrder(order)}>编辑订单</PermissionButton>
          <PermissionGate permission="order.event.post">
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "allocation", label: "分润", disabled: !["ACTIVE", "INSTALLMENT", "COMPLETED"].includes(order.status) },
                  { key: "refund", label: "资金收支", disabled: !["ACTIVE", "INSTALLMENT", "COMPLETED"].includes(order.status) },
                  {
                    key: "cancel",
                    label: canOffsaleConsignment ? "下架" : order.order_type === "DG" ? "取消" : "取消交易",
                    danger: true,
                    disabled: !["ACTIVE", "INSTALLMENT", "COMPLETED"].includes(order.status),
                  },
                ],
                onClick: ({ key }) => {
                  if (key === "allocation") void openAllocations(order);
                  if (key === "refund") void openRefund(order);
                  if (key === "cancel") {
                    if (canOffsaleConsignment) openSystemOffsale();
                    else void openCancelTransaction(order);
                  }
                },
              }}
            >
              <PermissionButton permission="order.event.post" type="link">更多</PermissionButton>
            </Dropdown>
          </PermissionGate>
        </Space>
        );
      },
    },
  ];
  const mobileLedgerFieldOrder = arrangeLedgerColumns(ledgerColumns).map(columnKey);
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
    allocationForm,
    allocationIsLoss,
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
    currentOperator,
    editForm,
    editOpen,
    editSubmitting,
    employeeOptions,
    expandedOrderIds,
    exportLedger,
    onExportLedger: exportLedger,
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
    ledgerSortDesc,
    mobileLedgerFieldOrder,
    load,
    loadError,
    loading,
    openAllocations,
    openCancelTransaction,
    openEditOrder,
    openRefund,
    openSystemOffsale,
    orderHasPostedEvents,
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
    setRefundOpen,
    setRefundSubmitting,
    setSelectedOrder,
    setTypes,
    setUsers,
    sharedCancellationEvent,
    submitCancelTransaction,
    submitEditOrder,
    typeNames,
    types,
    users,
    ledgerColumns,
    orderBusinessOptions,
    orderBusinessModeOptions,
    profitRoleOptions,
  };
}

export type OrdersPageController = ReturnType<typeof useOrdersPageController>;
