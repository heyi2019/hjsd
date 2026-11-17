import { Form } from "antd";
import { useState } from "react";
import { installmentsApi } from "../../shared/api/installments.api";
import { ordersApi } from "../../shared/api/orders.api";
import { employeesApi } from "../../shared/api/org.api";
import { poolsApi } from "../../shared/api/pools.api";
import type { Pool } from "../../shared/api/types/finance";
import type { Installment } from "../../shared/api/types/installments";
import type { Order } from "../../shared/api/types/orders";
import { currentDevUser, currentUser, normalizeError } from "../../shared/api/client";
import { money, today } from "../../shared/lib/format";
import { appMessage } from "../../shared/ui/appFeedback";
import { pickCancelableEvent, resolveCancelAmount, type CancelFormScope } from "./helpers";

/**
 * 订单「冲销 / 取消」域：普通订单的分笔冲销、原路退款与分期合约取消。
 * 从 useOrdersPageController 拆出，依赖注入 selectedOrder / load / setSelectedOrder。
 * 余额一律取后端 event.cancellable_amount，前端只挑事件与顺序，不做第二套金额账。
 */
export function useOrderCancellation(params: {
  selectedOrder: Order | null;
  setSelectedOrder: (order: Order | null) => void;
  load: () => Promise<void>;
}) {
  const { selectedOrder, setSelectedOrder, load } = params;
  const currentOperator = currentDevUser();
  const [cancelOrderTarget, setCancelOrderTarget] = useState<Order | null>(null);
  const [cancelInstallmentTarget, setCancelInstallmentTarget] = useState<Installment | null>(null);
  const [cancelScope, setCancelScope] = useState<CancelFormScope>("ORDERCANC");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelPools, setCancelPools] = useState<Pool[]>([]);
  const [cancelEmployees, setCancelEmployees] = useState<Array<{ id: number; username: string; display_name: string; is_active: boolean }>>([]);
  const [cancelForm] = Form.useForm();

  /**
   * 可冲销动作：已过账的 BUY/SELL，按「剩余可冲金额」过滤（后端支持部分冲销）。
   * 余额由后端 `event.cancellable_amount` 下发，前端只负责挑哪一条、按什么顺序 -
   * 不再自己遍历 CANCEL 事件做 `amount − Σcancel`（那是与库存页、提交校验并行的第三套）。
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
        // 避免用户在下拉尚未加载时确认导致无请求、无结果的"假提交"。
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
          // 用户直接确认弹窗时，最后一次从当前会话解析员工 ID，确保后端收到显式操作人。
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
            : `取消已登记：退款 ¥${money(result.event.amount)}，已按原资金账户退还客户`);
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

  const sharedCancellationEvent = cancelOrderTarget
    ? cancelableEventsForScope(cancelOrderTarget, cancelScope)[0]
    : undefined;
  const hasSharedCancellation = Boolean(sharedCancellationEvent);

  return {
    cancelEmployees,
    setCancelEmployees,
    cancelForm,
    cancelInstallmentTarget,
    setCancelInstallmentTarget,
    cancelOrderTarget,
    setCancelOrderTarget,
    cancelPools,
    setCancelPools,
    cancelScope,
    setCancelScope,
    cancelSubmitting,
    setCancelSubmitting,
    cancelableEventsForScope,
    reversibleEvents,
    closeCancelTransaction,
    openCancelTransaction,
    submitCancelTransaction,
    sharedCancellationEvent,
    hasSharedCancellation,
  };
}
