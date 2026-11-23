import { Form } from "antd";
import dayjs from "dayjs";
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
import { cancelRefundSuccess } from "../../shared/lib/cancellationCopy";
import { formExtraOrUndefined } from "../../shared/lib/formExtra";
import { appMessage } from "../../shared/ui/appFeedback";
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import type { LatestRequest } from "../../shared/hooks/useLatestRequest";
import { pickCancelableEvent, resolveCancelAmount, resolveCancellationOperators, type CancelFormScope } from "./helpers";

/**
 * 订单「冲销 / 取消」域：普通订单的分笔冲销、原路退款与分期合约取消。
 * 余额一律取后端 event.cancellable_amount，前端只挑事件与顺序，不做第二套金额账。
 */
export function useOrderCancellation(params: {
  selectedOrder: Order | null;
  setSelectedOrder: (order: Order | null) => void;
  load: () => Promise<void>;
  refreshCachedLedgerDetail: (orderId: number) => Promise<void>;
  actionRequest: LatestRequest;
}) {
  const { selectedOrder, setSelectedOrder, load, refreshCachedLedgerDetail, actionRequest } = params;
  const currentOperator = currentDevUser();
  const [cancelOrderTarget, setCancelOrderTarget] = useState<Order | null>(null);
  const [cancelInstallmentTarget, setCancelInstallmentTarget] = useState<Installment | null>(null);
  const [cancelScope, setCancelScope] = useState<CancelFormScope>("ORDERCANC");
  const cancelWrite = useAsyncAction();
  const cancelSubmitting = cancelWrite.pending;
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
    const request = actionRequest.start();
    try {
      const order = sourceOrder ? await ordersApi.get(sourceOrder.id) : selectedOrder;
      if (!order || !actionRequest.isCurrent(request)) return;
      const hasActiveInstallment = Boolean(order.installment_principal && order.installment_status !== "CANCELLED");
      if (hasActiveInstallment) {
        let target: Installment | undefined;
        let offset = 0;
        do {
          const page = await installmentsApi.page({ order_id: order.id, limit: 500, offset, sort_desc: false });
          if (!actionRequest.isCurrent(request)) return;
          target = page.items.find((item) => !["CANCELLED", "DELIVERED"].includes(item.status));
          offset += page.items.length;
          if (target || offset >= page.total) break;
          if (page.items.length === 0) {
            appMessage.error("分期合约读取不完整，请重试");
            return;
          }
        } while (true);
        if (!target) {
          appMessage.error("未找到可取消的分期合约");
          return;
        }
        cancelForm.resetFields();
        cancelForm.setFieldsValue({ cancelled_on: today() });
        setCancelInstallmentTarget(target);
        setCancelOrderTarget(null);
      } else {
        // 取消弹窗依赖资金账户和操作人主数据；先准备完整上下文，再打开弹窗，
        // 避免用户在下拉尚未加载时确认导致无请求、无结果的"假提交"。
        const reversible = reversibleEvents(order);
        const first = reversible[0];
        const unsoldInventory = order.status === "ACTIVE" && ["HS", "TH"].includes(order.order_type) && order.account_id != null;
        const nextScope: CancelFormScope = first?.event.event_type === "BUY" || (!first && unsoldInventory) ? "INVREFUND" : "ORDERCANC";
        const [poolList, employeeList] = await Promise.all([poolsApi.list(), employeesApi.list()]);
        if (!actionRequest.isCurrent(request)) return;
        const activeEmployees = employeeList.filter((employee) => employee.is_active);
        setCancelPools(poolList.filter((pool) => pool.status === "ACTIVE"));
        setCancelEmployees(activeEmployees);
        // 先在打开弹窗的加载阶段写入默认操作人，避免依赖 ResponsibleEmployeeSelect
        // 内部的 /auth/me 异步回填；提交动作必须始终携带显式员工 ID。
        const defaultEmployee = activeEmployees.find((employee) => employee.username === currentOperator)
          ?? (activeEmployees.length === 1 ? activeEmployees[0] : undefined);
        cancelForm.resetFields();
        cancelForm.setFieldsValue({
          cancelled_on: today(),
          offset_event_id: first?.event.id,
          [nextScope === "INVREFUND" ? "refund_amount" : "cancel_amount"]: first?.remaining,
          amount: first?.remaining ?? "0.00",
          pool_id: first?.event.pool_id ?? (first ? poolList[0]?.id : undefined),
          operator_user_ids: defaultEmployee ? [defaultEmployee.id] : undefined,
        });
        setCancelScope(nextScope);
        setCancelOrderTarget(order);
        setCancelInstallmentTarget(null);
      }
    } catch (error) {
      if (actionRequest.isCurrent(request)) appMessage.error(normalizeError(error).message);
    }
  };

  const closeCancelTransaction = () => {
    actionRequest.invalidate();
    setCancelOrderTarget(null);
    setCancelInstallmentTarget(null);
    setCancelScope("ORDERCANC");
    cancelForm.resetFields();
  };

  const submitCancelTransaction = async (values: { cancelled_on: string; reason: string; offset_event_id?: number; amount?: string; cancel_amount?: string; refund_amount?: string; pool_id?: number; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) => {
    const installment = cancelInstallmentTarget;
    const order = cancelOrderTarget;
    if (!installment && !order) return;
    const formExtra = formExtraOrUndefined(values.form_extra);
    const session = actionRequest.current();
    const targetNo = order?.order_no ?? installment?.inst_no ?? "订单";
    const success = (text: string) => appMessage.success(actionRequest.isCurrent(session) ? text : `${targetNo}：${text}`);
    const complete = () => {
      if (actionRequest.isCurrent(session)) {
        closeCancelTransaction();
        setSelectedOrder(null);
      }
      const orderId = order?.id ?? installment?.order_id;
      void Promise.all([load(), orderId == null ? undefined : refreshCachedLedgerDetail(orderId)])
        .catch(() => appMessage.warning("交易已取消，但台账刷新失败，请手动刷新"));
    };
    await cancelWrite.run(async () => {
      try {
        if (installment) {
          const result = await installmentsApi.cancel(installment.id, { ...values, form_extra: formExtra }, "ORDER");
          success(cancelRefundSuccess(result.refund_amount, installment.contract_type));
          complete();
        } else {
          if (!order) return;
          const reversible = cancelableEventsForScope(order, cancelScope);
          const selected = pickCancelableEvent(reversible, values.offset_event_id);
          if (cancelScope === "INVREFUND" && order.account_id != null) {
            const amount = values.amount ?? selected?.remaining ?? "0.00";
            const operatorUserIds = await resolveCancellationOperators(values.operator_user_ids, cancelEmployees, currentOperator, currentUser);
            await ordersApi.inventoryOffsale(order.id, {
              amount,
              occurred_on: values.cancelled_on,
              unlisted_at: `${values.cancelled_on}T${dayjs().format("HH:mm")}`,
              ...(Number(amount) > 0 ? { pool_id: Number(values.pool_id), offset_event_id: selected?.event.id } : {}),
              operator_user_ids: operatorUserIds,
              reason: values.reason.trim(),
              form_extra: formExtra,
            });
            success("交易已取消，账号已退出库存");
            complete();
            return;
          }
          if (selected) {
            const resolved = resolveCancelAmount({ scope: cancelScope, values, remaining: selected.remaining });
            if (!resolved.ok) {
              appMessage.error(resolved.error);
              return;
            }
            const amount = resolved.amount;
            const operatorUserIds = await resolveCancellationOperators(values.operator_user_ids, cancelEmployees, currentOperator, currentUser);
            const result = await ordersApi.postEvent(order.id, {
              event_type: "CANCEL",
              finalize_sale_cancel: ["HS", "TH"].includes(order.order_type),
              amount,
              occurred_on: values.cancelled_on,
              offset_event_id: selected.event.id,
              pool_id: Number(values.pool_id),
              operator_user_ids: operatorUserIds,
              reason: values.reason,
              note: cancelScope === "INVREFUND" ? "取消：冲销入库并入账" : "取消：原路退款",
              form_extra_scope: cancelScope,
              form_extra: formExtra,
            });
            success(cancelScope === "INVREFUND"
              ? `取消已登记：入账 ¥${money(result.event.amount)}，已进入公司钱包`
              : `取消已登记：退款 ¥${money(result.event.amount)}，已按原资金账户退还客户`);
          } else {
            await ordersApi.cancel(order.id, { reason: values.reason, form_extra: formExtra });
            success("交易已取消，无已登记款项需要退款");
          }
          complete();
        }
      } catch (error) {
        const message = normalizeError(error).message;
        appMessage.error(actionRequest.isCurrent(session) ? message : `${targetNo}：${message}`);
      }
    });
  };

  const sharedCancellationEvent = cancelOrderTarget
    ? cancelableEventsForScope(cancelOrderTarget, cancelScope)[0]
    : undefined;
  const hasSharedCancellation = Boolean(sharedCancellationEvent || (cancelOrderTarget && cancelScope === "INVREFUND" && cancelOrderTarget.account_id != null));

  return {
    cancelEmployees,
    cancelForm,
    cancelInstallmentTarget,
    cancelOrderTarget,
    cancelPools,
    cancelScope,
    cancelSubmitting,
    cancelableEventsForScope,
    closeCancelTransaction,
    openCancelTransaction,
    submitCancelTransaction,
    sharedCancellationEvent,
    hasSharedCancellation,
  };
}
