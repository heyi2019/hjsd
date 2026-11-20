import { Form } from "antd";
import { useRef, useState } from "react";
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
import { consignmentRecords, type ActiveConsignment } from "../operations";
import type { OrderProfileTarget } from "../operations";
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
}

/**
 * 订单台账的动作弹窗域：资金收支 / 分润配置 / 交付 / 下架 / 账号动作。
 * 逐字切片自 useOrdersPageController，返回值与主 hook 的 spread 并集契约逐字段一致。
 */
export function useOrderActionModals({
  selectedOrder,
  load,
}: OrderActionModalsDeps) {
  const { username } = useSession();
  const [allocationOpen, setAllocationOpen] = useState(false);
  const [allocationSubmitting, setAllocationSubmitting] = useState(false);
  const [allocationForm] = Form.useForm();
  const allocationSession = useRef(0);
  const [orderRebateTarget, setOrderRebateTarget] = useState<Account | null>(null);
  const [orderSaleTarget, setOrderSaleTarget] = useState<Account | null>(null);
  const [orderConsignmentTarget, setOrderConsignmentTarget] = useState<{ account: Account; orderId: number } | null>(null);
  const [orderDeleteTarget, setOrderDeleteTarget] = useState<Order | null>(null);
  const [orderDeleteSubmitting, setOrderDeleteSubmitting] = useState(false);
  const [cashflowTarget, setCashflowTarget] = useState<CashflowTarget | null>(null);
  const cashflowRequest = useRef(0);
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
    const session = ++allocationSession.current;
    try {
      const order = sourceOrder ? await ordersApi.get(sourceOrder.id) : selectedOrder;
      if (!order || allocationSession.current !== session) return;
      const [result, userResult] = await Promise.all([
        profitAllocationApi.allocations(order.id),
        employeesApi.list(),
      ]);
      if (allocationSession.current !== session) return;
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
      // 比例框已改为只读参考，金额是唯一提交口径。金额模式存库后库里 rate 为 0，
      // 回显时用金额经 convert 反算比例供展示；历史比例模式数据（有 rate 无金额）
      // 则反向补金额，避免用户不改直接提交时把配置清成空金额。
      let requiredConversionFailed = false;
      await Promise.all(rows.map(async (row) => {
        if (row.allocation_type === "COMPANY") return;
        const amount = (row.allocation_amount ?? "").trim();
        const rate = (row.allocation_rate ?? "").trim();
        if (amount && Number(amount) !== 0) {
          const converted = await profitAllocationApi.convert(order.id, "AMOUNT_TO_RATE", amount).catch(() => null);
          if (converted?.value != null) row.allocation_rate = converted.value;
        } else if (rate && Number(rate) !== 0) {
          const converted = await profitAllocationApi.convert(order.id, "RATE_TO_AMOUNT", rate).catch(() => null);
          if (converted?.value != null) row.allocation_amount = converted.value;
          else requiredConversionFailed = true;
        }
      }));
      if (allocationSession.current !== session) return;
      if (requiredConversionFailed) {
        appMessage.error("分润金额换算失败，请重试");
        return;
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
      if (allocationSession.current === session) appMessage.error(normalizeError(error).message);
    }
  };

  const closeAllocations = () => {
    allocationSession.current += 1;
    setAllocationOpen(false);
    setActionOrder(null);
  };
  const getAllocationSession = () => allocationSession.current;

  const openRefund = async (sourceOrder?: Order) => {
    const request = ++cashflowRequest.current;
    try {
      const order = sourceOrder ? await ordersApi.get(sourceOrder.id) : selectedOrder;
      if (!order || cashflowRequest.current !== request) return;
      const [employeeList, poolList] = await Promise.all([employeesApi.list(), poolsApi.list()]);
      if (cashflowRequest.current !== request) return;
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
      if (cashflowRequest.current === request) appMessage.error(normalizeError(error).message);
    }
  };
  const closeCashflow = () => {
    cashflowRequest.current += 1;
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
      if (account) setOrderConsignmentTarget({ account, orderId: sourceOrder.id });
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  const openOrderDelete = (sourceOrder: Order) => {
    setOrderDeleteTarget(sourceOrder);
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
      const detail = await ordersApi.executionDetail(sourceOrder.id);
      const records = consignmentRecords(detail.orders);
      if (!records.length && detail.account.inventory_type !== "CONSIGNMENT") {
        appMessage.warning("当前账号没有仍在平台上的寄售记录");
        return;
      }
      setOrderOffsaleTarget({ account: detail.account, records, orderId: sourceOrder.id });
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
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
      setOrderOffsaleTarget(null);
      await load();
    } catch (error) {
      appMessage.error(normalizeError(error).message);
      throw error;
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
      await ordersApi.deleteOrder(orderDeleteTarget.id, reason);
      appMessage.success("已删除");
      setOrderDeleteTarget(null);
      await load();
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setOrderDeleteSubmitting(false);
    }
  };

  return {
    actionOrder,
    allocationCandidates,
    allocationForm,
    allocationIsLoss,
    allocationOpen,
    allocationProfit,
    allocationSubmitting,
    closeAllocations,
    getAllocationSession,
    setAllocationProfit,
    setAllocationSubmitting,
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
    setOrderConsignmentTarget,
    orderDeleteSubmitting,
    orderDeleteTarget,
    setOrderDeleteTarget,
    orderOffsaleTarget,
    setOrderOffsaleTarget,
    orderRebateTarget,
    setOrderRebateTarget,
    orderSaleTarget,
    setOrderSaleTarget,
    profileTarget,
    setProfileTarget,
    submitOrderDelete,
    openOrderProfile,
  };
}
