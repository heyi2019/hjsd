import { Form } from "antd";
import { useState } from "react";
import { normalizeError } from "../../shared/api/client";
import { ordersApi } from "../../shared/api/orders.api";
import { employeesApi } from "../../shared/api/org.api";
import { profitAllocationApi } from "../../shared/api/profitAllocation.api";
import type { Order } from "../../shared/api/types/orders";
import type { LatestRequest } from "../../shared/hooks/useLatestRequest";
import { appMessage } from "../../shared/ui/appFeedback";
import { buildActionAllocationRows, type ActionAllocationCandidates, type AllocationFormRow } from "./allocationHelpers";

export function useProfitAllocation(selectedOrder: Order | null, actionRequest: LatestRequest) {
  const [allocationOpen, setAllocationOpen] = useState(false);
  const [allocationForm] = Form.useForm();
  /** 扣除公司配置比例后的可分配利润，负数表示可分配的亏损分担额。 */
  const [allocationProfit, setAllocationProfit] = useState<string>("0");
  const [allocationOrderProfit, setAllocationOrderProfit] = useState<string>("0");
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
      if (typeof result.order_profit !== "string" || typeof result.company_rate !== "string" || typeof result.allocatable_profit !== "string" || !result.totals_by_type || !result.action_candidates
        || !(["BUY", "SELL", "OPERATION", "COMPANY"] as const).every((key) => Array.isArray(result.action_candidates[key]))) {
        appMessage.error("分润数据不完整，请刷新后重试");
        return;
      }
      const candidates = result.action_candidates;
      const rows: AllocationFormRow[] = buildActionAllocationRows(result.items, candidates, result.totals_by_type);
      const companyRow = rows.find((row) => row.allocation_type === "COMPANY");
      if (companyRow) {
        companyRow.allocation_rate = result.company_rate;
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
      setAllocationProfit(result.allocatable_profit);
      setAllocationOrderProfit(result.order_profit);
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

  return {
    actionOrder, allocationCandidates, allocationForm, allocationIsLoss,
    allocationOpen, allocationProfit, allocationOrderProfit, closeAllocations,
    getAllocationSession, employeeOptions, openAllocations,
  };
}
