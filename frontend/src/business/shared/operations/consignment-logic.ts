import type { AccountExecutionOrder } from "../../../shared/api/types/account-execution";
import { formatDateTimeMinute } from "../../../shared/lib/format";

/** 寄售记录：寄售是原订单上的 OPERATE 事件，不是单独的 DG 订单。 */
export type ConsignmentListing = {
  /** 同一订单可多次在同一平台上架，下架定位必须精确到该条运营事件。 */
  id: string;
  orderId: number;
  orderNo: string;
  eventId?: number;
  platform: string;
  platformLabel?: string;
  price: number | string | null;
  listedAt: string;
};

export function availableConsignmentPlatforms<T extends { value: string }>(options: T[], listed: Array<{ platform: string }>): T[] {
  const unavailable = new Set(listed.map((item) => item.platform));
  return options.filter((option) => !unavailable.has(option.value));
}

/** 展示服务端返回的当前上架记录，未加载到状态时不推测。 */
export function activeConsignmentListings(order: AccountExecutionOrder): ConsignmentListing[] {
  return (order.active_consignments ?? []).map((item) => ({
    id: `${order.order_id}:${item.event_id}:${item.platform}`,
    orderId: order.order_id,
    orderNo: order.order_no,
    eventId: item.event_id,
    platform: item.platform,
    ...(item.platform_label ? { platformLabel: item.platform_label } : {}),
    price: item.price,
    listedAt: formatDateTimeMinute(item.listed_at),
  }));
}

export function consignmentListings(orders: AccountExecutionOrder[]): ConsignmentListing[] {
  return orders.flatMap(activeConsignmentListings);
}

/** 订单是否仍有当前寄售上架记录。 */
export function isActiveConsignmentListing(order: AccountExecutionOrder): boolean {
  return activeConsignmentListings(order).length > 0;
}
