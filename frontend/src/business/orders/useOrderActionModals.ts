import { Form } from "antd";
import { useState } from "react";
import { useSession } from "../../shared/state/session";
import { currentDevUser, normalizeError } from "../../shared/api/client";
import type { CashflowTarget } from "../../finance/cashflow";
import { ordersApi } from "../../shared/api/orders.api";
import { employeesApi } from "../../shared/api/org.api";
import { profitAllocationApi } from "../../shared/api/profitAllocation.api";
import { poolsApi } from "../../shared/api/pools.api";
import type { Account } from "../../shared/api/types/accounts";
import type { Pool } from "../../shared/api/types/finance";
import type { EmployeeOption } from "../../shared/api/types/org";
import type { Order } from "../../shared/api/types/orders";
import { appMessage } from "../../shared/ui/appFeedback";
import type { LatestRequest } from "../../shared/hooks/useLatestRequest";
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import { consignmentRecords, type ActiveConsignment } from "../shared/operations";
import type { OrderProfileTarget } from "../shared/operations";
import { buildCashflowDisplayItems } from "../../finance/cashflow";
import {
  buildActionAllocationCandidates,
  buildActionAllocationRows,
  type ActionAllocationCandidates,
  type AllocationFormRow,
} from "./helpers";

/** 由主 controller 注入的跨域共享枢纽；子 hook 不自行持有这些状态。 */
interface OrderActionModalsDeps {
  selectedOrder: Order | null;
  load: () => Promise<void> | void;
  loadLedgerDetail: (order: Pick<Order, "id" | "account_id">, force?: boolean) => Promise<void>;
  actionRequest: LatestRequest;
}

/**
 * 订单台账的动作弹窗域：资金收支 / 分润配置 / 交付 / 下架 / 账号动作。
 * 逐字切片自 useOrdersPageController，返回值与主 hook 的 spread 并集契约逐字段一致。
 */
export function useOrderActionModals({
  selectedOrder,
  load,
  loadLedgerDetail,
  actionRequest,
}: OrderActionModalsDeps) {
  const { username } = useSession();
  const [allocationOpen, setAllocationOpen] = useState(false);
  const [allocationForm] = Form.useForm();
  const [orderRebateTarget, setOrderRebateTarget] = useState<Account | null>(null);
  const [orderSaleTarget, setOrderSaleTarget] = useState<Account | null>(null);
  const [orderConsignmentTarget, setOrderConsignmentTarget] = useState<{ account: Account; orderId: number } | null>(null);
  const [orderDeleteTarget, setOrderDeleteTarget] = useState<Order | null>(null);
  const deleteWrite = useAsyncAction();
  const orderDeleteSubmitting = deleteWrite.pending;
  const [cashflowTarget, setCashflowTarget] = useState<CashflowTarget | null>(null);
  const [cashflowPools, setCashflowPools] = useState<Pool[]>([]);
  const [cashflowUsers, setCashflowUsers] = useState<EmployeeOption[]>([]);
  const [profileTarget, setProfileTarget] = useState<OrderProfileTarget | null>(null);
  const [orderOffsaleTarget, setOrderOffsaleTarget] = useState<{ account: Account; records: ActiveConsignment[]; orderId: number } | null>(null);
  /** 扣除公司配置比例后的可分配利润，负数表示可分配的亏损分担额。 */
  const [allocationProfit, setAllocationProfit] = useState<string>("0");
  /** 按操作分配时的动作执行人候选，来自建单/售出操作人和运营信息中的操作人。 */
  const [allocationCandidates, setAllocationCandidates] = useState<ActionAllocationCandidates>({ BUY: [], SELL: [], OPERATION: [], COMPANY: [] });
  const [actionOrder, setActionOrder] = useState<Order | null>(null);
  const [users, setUsers] = useState<Array<{ id: number; username: string; display_name: string; is_active: boolean }>>([]);
  // 员工花名册 = 在职用户；另加「公司归属」用来表达留给公司、不绑定人的那部分。
  const employeeOptions = [
    ...users.map((item) => ({
      value: item.id as number | "COMPANY",
      label: item.display_name,
    })),
    { value: "COMPANY" as number | "COMPANY", label: "公司（不绑定人员）" },
  ];
  /** 亏损单（总利润 < 0）：顶部提示改口径，金额分润后端也会拒绝。 */
  const allocationIsLoss = Number(allocationProfit) < 0;
  const openAllocations = async (sourceOrder?: Order) => {
    const session = actionRequest.start();
    try {
      const target = sourceOrder ?? selectedOrder;
      if (!target) return;
      const [order, result, userResult] = await Promise.all([
        sourceOrder ? ordersApi.get(target.id) : Promise.resolve(target),
        profitAllocationApi.allocations(target.id),
        employeesApi.list(),
      ]);
      if (!actionRequest.isCurrent(session)) return;
      const currentEmployee = userResult.find((item) => item.is_active && item.username === username)
        ?? (import.meta.env.DEV
          ? userResult.find((item) => item.is_active && item.username === currentDevUser())
          : undefined);
      const candidates = buildActionAllocationCandidates(order, currentEmployee?.id);
      const rows: AllocationFormRow[] = buildActionAllocationRows(result.items, candidates, result.totals_by_type);
      const companyRow = rows.find((row) => row.allocation_type === "COMPANY");
      if (companyRow) {
        companyRow.allocation_rate = result.company_rate ?? "40";
        companyRow.allocation_amount = "";
      }
      // 弹窗是复用的：先清空上次打开残留的字段（含 form_extra 自定义字段），再回填本单数据。
      allocationForm.resetFields();
      allocationForm.setFieldsValue({
        allocations: rows,
      });
      setActionOrder(order);
      setUsers(userResult.filter((item) => item.is_active));
      setAllocationCandidates(candidates);
      setAllocationProfit(result.allocatable_profit ?? result.order_profit ?? "0");
      setAllocationOpen(true);
    } catch (error) {
      if (actionRequest.isCurrent(session)) appMessage.error(normalizeError(error).message);
    }
  };

  const closeAllocations = () => {
    actionRequest.invalidate();
    setAllocationOpen(false);
    setActionOrder(null);
  };
  const getAllocationSession = actionRequest.current;

  const openRefund = async (sourceOrder?: Order) => {
    const request = actionRequest.start();
    try {
      const target = sourceOrder ?? selectedOrder;
      if (!target) return;
      const [order, employeeList, poolList] = await Promise.all([
        sourceOrder ? ordersApi.get(target.id) : Promise.resolve(target),
        employeesApi.list(),
        poolsApi.list(),
      ]);
      if (!actionRequest.isCurrent(request)) return;
      const activeEmployees = employeeList.filter((employee) => employee.is_active);
      setUsers(activeEmployees);
      setCashflowUsers(activeEmployees);
      const activePools = poolList.filter((pool) => pool.status === "ACTIVE");
      // 资金收支必须指认资金账户：带上可用池并默认选中第一个，用户仍可改。
      setCashflowPools(activePools);
      setCashflowTarget({
        orderId: order.id,
        orderNo: order.order_no,
        cashflows: buildCashflowDisplayItems(order.cashflows),
      });
    } catch (error) {
      if (actionRequest.isCurrent(request)) appMessage.error(normalizeError(error).message);
    }
  };
  const closeCashflow = () => {
    actionRequest.invalidate();
    setCashflowTarget(null);
  };

  const loadOrderAccount = async (sourceOrder: Order) => {
    if (!sourceOrder.account_id) {
      appMessage.warning("该订单未关联库存账号，无法执行账号动作");
      return null;
    }
    const detail = await ordersApi.executionDetail(sourceOrder.id);
    return detail.account;
  };

  const openOrderRebate = async (sourceOrder: Order) => {
    const request = actionRequest.start();
    try {
      const account = await loadOrderAccount(sourceOrder);
      if (account && actionRequest.isCurrent(request)) setOrderRebateTarget(account);
    } catch (error) {
      if (actionRequest.isCurrent(request)) appMessage.error(normalizeError(error).message);
    }
  };

  const openOrderSale = async (sourceOrder: Order) => {
    const request = actionRequest.start();
    try {
      const account = await loadOrderAccount(sourceOrder);
      if (account && actionRequest.isCurrent(request)) setOrderSaleTarget(account);
    } catch (error) {
      if (actionRequest.isCurrent(request)) appMessage.error(normalizeError(error).message);
    }
  };

  const openOrderConsignment = async (sourceOrder: Order) => {
    const request = actionRequest.start();
    try {
      const account = await loadOrderAccount(sourceOrder);
      if (account && actionRequest.isCurrent(request)) setOrderConsignmentTarget({ account, orderId: sourceOrder.id });
    } catch (error) {
      if (actionRequest.isCurrent(request)) appMessage.error(normalizeError(error).message);
    }
  };

  const openOrderDelete = (sourceOrder: Order) => {
    actionRequest.start();
    setOrderDeleteTarget(sourceOrder);
  };
  const closeOrderSale = () => { actionRequest.invalidate(); setOrderSaleTarget(null); };
  const closeOrderConsignment = () => { actionRequest.invalidate(); setOrderConsignmentTarget(null); };
  const closeOrderRebate = () => { actionRequest.invalidate(); setOrderRebateTarget(null); };
  const closeOrderProfile = () => { actionRequest.invalidate(); setProfileTarget(null); };
  const closeOrderOffsale = () => { actionRequest.invalidate(); setOrderOffsaleTarget(null); };
  const closeOrderDelete = () => { actionRequest.invalidate(); setOrderDeleteTarget(null); };

  const openOrderProfile = async (sourceOrder: Order, mode: "description" | "images") => {
    const request = actionRequest.start();
    try {
      const account = await loadOrderAccount(sourceOrder);
      if (account && actionRequest.isCurrent(request)) setProfileTarget({ account, mode, orderId: sourceOrder.id });
    } catch (error) {
      if (actionRequest.isCurrent(request)) appMessage.error(normalizeError(error).message);
    }
  };

  const openOrderOffsale = async (sourceOrder: Order) => {
    const request = actionRequest.start();
    try {
      if (!sourceOrder.account_id) {
        appMessage.warning("该订单未关联库存账号，无法下架");
        return;
      }
      const detail = await ordersApi.executionDetail(sourceOrder.id);
      if (!actionRequest.isCurrent(request)) return;
      const records = consignmentRecords(detail.orders);
      if (!records.length && detail.account.inventory_type !== "CONSIGNMENT") {
        appMessage.warning("当前账号没有仍在平台上的寄售记录");
        return;
      }
      setOrderOffsaleTarget({ account: detail.account, records, orderId: sourceOrder.id });
    } catch (error) {
      if (actionRequest.isCurrent(request)) appMessage.error(normalizeError(error).message);
    }
  };

  const refreshOffsale = async (target: typeof orderOffsaleTarget) => {
    await Promise.all([
      load(),
      target ? loadLedgerDetail({ id: target.orderId, account_id: target.account.id }, true) : undefined,
    ]);
  };

  const handleOrderSystemOffsale = async (payload: { reason: string; unlisted_at: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) => {
    const target = orderOffsaleTarget;
    if (!target) return;
    try {
      await ordersApi.inventoryOffsale(target.account.source_order_id ?? target.orderId, {
        reason: payload.reason,
        operator_user_ids: payload.operator_user_ids,
        occurred_on: payload.unlisted_at.slice(0, 10),
        unlisted_at: payload.unlisted_at,
        form_extra: payload.form_extra,
      });
      appMessage.success("寄售记录已下架，账号已出库");
      void refreshOffsale(target).catch(() => appMessage.warning("已出库，但刷新失败，请手动刷新"));
    } catch (error) {
      appMessage.error(normalizeError(error).message);
      throw error;
    }
  };

  const handleOrderOffsaleChanged = async () => {
    await refreshOffsale(orderOffsaleTarget);
  };

  const submitOrderDelete = async (reason: string) => {
    const target = orderDeleteTarget;
    if (!target) return;
    const session = actionRequest.current();
    await deleteWrite.run(async () => {
      try {
        await ordersApi.deleteOrder(target.id, reason);
        appMessage.success("已删除");
        if (actionRequest.isCurrent(session)) closeOrderDelete();
        void Promise.resolve().then(load).catch(() => appMessage.warning("已删除，但刷新失败，请手动刷新"));
      } catch (error) {
        const message = normalizeError(error).message;
        appMessage.error(actionRequest.isCurrent(session) ? message : `${target.order_no}：${message}`);
      }
    });
  };

  return {
    actionOrder,
    allocationCandidates,
    allocationForm,
    allocationIsLoss,
    allocationOpen,
    allocationProfit,
    closeAllocations,
    getAllocationSession,
    setAllocationProfit,
    cashflowPools,
    cashflowTarget,
    cashflowUsers,
    closeCashflow,
    employeeOptions,
    users,
    setUsers,
    handleOrderOffsaleChanged,
    handleOrderSystemOffsale,
    openAllocations,
    openOrderConsignment,
    openOrderDelete,
    openOrderOffsale,
    openOrderRebate,
    openOrderSale,
    openRefund,
    orderConsignmentTarget,
    closeOrderConsignment,
    orderDeleteSubmitting,
    orderDeleteTarget,
    closeOrderDelete,
    orderOffsaleTarget,
    closeOrderOffsale,
    orderRebateTarget,
    closeOrderRebate,
    orderSaleTarget,
    closeOrderSale,
    profileTarget,
    closeOrderProfile,
    submitOrderDelete,
    openOrderProfile,
  };
}
