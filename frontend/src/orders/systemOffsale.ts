import { ordersApi } from "../shared/api/orders.api";

interface SystemOffsaleCancellation {
  /** 需要同步取消的代挂（DG）订单 ID 列表，由调用点按自身数据源筛选。 */
  orderIds: number[];
  /** UNLIST 操作事件的备注文案。 */
  note: string;
  /** 取消订单的原因。 */
  reason: string;
  /** 事件发生日期（YYYY-MM-DD）。 */
  occurredOn: string;
  /** 下架表单的扩展字段，原样并入两个请求的 form_extra。 */
  formExtra?: Record<string, unknown>;
}

/**
 * 系统下架时同步取消代挂订单：先登记 UNLIST 操作事件，再取消订单。
 * 顺序不可颠倒——避免出现 ERP 已下架但平台上架记录仍有效的中间结果。
 *
 * 三处入口（库存 Void 下架、库存平台下架弹窗、订单页系统下架）的文案、日期来源与
 * form_extra 内容各不相同，故全部由调用点传入，本函数只固化共用的请求骨架。
 */
export async function unlistAndCancelConsignmentOrders({
  orderIds,
  note,
  reason,
  occurredOn,
  formExtra,
}: SystemOffsaleCancellation): Promise<void> {
  await Promise.all(orderIds.map(async (orderId) => {
    // 同一次下架的两个请求共用同一时间戳，避免分两次取值在分钟边界产生不一致。
    const unlistExtra = {
      ...formExtra,
      platform_unlist_scope: "SYSTEM",
      platform_unlisted_at: new Date().toISOString().slice(0, 16),
    };
    await ordersApi.postEvent(orderId, {
      event_type: "OPERATE",
      operation_type: "UNLIST",
      occurred_on: occurredOn,
      note,
      form_extra_scope: "INVOID",
      form_extra: { ...unlistExtra },
    });
    return ordersApi.cancel(orderId, {
      reason,
      form_extra_scope: "INVOID",
      form_extra: { ...unlistExtra },
    });
  }));
}
