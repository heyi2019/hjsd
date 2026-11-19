import { ordersApi } from "../../shared/api/orders.api";
import dayjs from "dayjs";
import type { ActiveConsignment } from "./offsale";

interface SystemOffsaleCancellation {
  /** 需要同步登记下架的当前寄售记录。 */
  records: ActiveConsignment[];
  /** 系统出库时需要取消的主业务订单；平台下架不传此字段。 */
  cancelOrderIds?: number[];
  /** UNLIST 操作事件的备注文案。 */
  note: string;
  /** 取消订单的原因。 */
  reason: string;
  /** 事件发生日期（YYYY-MM-DD）。 */
  occurredOn: string;
  unlistedAt?: string;
  /** 本次下架的操作人，沿用建单/业务事件的默认当前员工并支持多选。 */
  operatorUserIds?: number[];
  /** 下架表单的扩展字段，原样并入两个请求的 form_extra。 */
  formExtra?: Record<string, unknown>;
}

/**
 * 系统下架时同步登记原订单的 UNLIST 操作事件；只有真正执行 ERP 出库时，
 * 调用方才传入 cancelOrderIds 取消主业务订单；平台下架不传该参数，系统下架才传入。
 *
 * 三处入口（库存 Void 下架、库存平台下架弹窗、订单页系统下架）的文案、日期来源与
 * form_extra 内容各不相同，故全部由调用点传入，本函数只固化共用的请求骨架。
 */
export async function unlistAndCancelConsignmentOrders({
  records,
  cancelOrderIds = [],
  note,
  reason,
  occurredOn,
  unlistedAt,
  operatorUserIds,
  formExtra,
}: SystemOffsaleCancellation): Promise<void> {
  const timestamp = unlistedAt ?? dayjs().format("YYYY-MM-DDTHH:mm");
  await Promise.all(records.map(async (record) => {
    // 同一次下架的两个请求共用同一时间戳，避免分两次取值在分钟边界产生不一致。
    const unlistExtra = {
      ...formExtra,
      platform_unlist_scope: "SYSTEM",
      platform_unlisted_at: timestamp,
    };
    await ordersApi.postEvent(record.orderId, {
      event_type: "OPERATE",
      operation_type: "UNLIST",
      occurred_on: occurredOn,
      operator_user_ids: operatorUserIds,
      note,
      form_extra_scope: "INVOID",
      form_extra: {
        ...unlistExtra,
        ...(record.eventId == null ? {} : { consignment_event_id: record.eventId }),
        consignment_platforms: [record.platform],
      },
    });
  }));
  await Promise.all([...new Set(cancelOrderIds)].map((orderId) => ordersApi.cancel(orderId, {
    reason,
    form_extra_scope: "INVOID",
    form_extra: {
      ...formExtra,
      platform_unlist_scope: "SYSTEM",
      platform_unlisted_at: timestamp,
    },
  })));
}
