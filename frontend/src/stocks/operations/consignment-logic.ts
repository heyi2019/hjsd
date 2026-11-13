import type { AccountExecutionEvent, AccountExecutionOrder } from "../../shared/api/types/account-execution";
import { formatDateTimeMinute } from "../../shared/lib/format";

/** 寄售记录：寄售是原订单上的 OPERATE 事件，不是单独的 DG 订单。 */
export type ConsignmentListing = {
  orderId: number;
  orderNo: string;
  eventId?: number;
  platform: string;
  price: number | string | null;
  listedAt: string;
};

/** 返回当前订单寄售事件记录的平台；寄售不读取订单类型或订单扩展字段。 */
export function consignmentPlatform(order: AccountExecutionOrder): string | null {
  const event = (order.events ?? []).find((item) => item.event_type === "OPERATE" && item.operation_type === "CONSIGNMENT");
  const configured = event?.form_extra?.consignment_platform;
  return typeof configured === "string" && configured.trim() ? configured.trim() : null;
}

function eventExtra(event: AccountExecutionEvent): Record<string, unknown> {
  return event.form_extra ?? {};
}

function eventPlatform(event: AccountExecutionEvent, order: AccountExecutionOrder): string | null {
  const configured = eventExtra(event).consignment_platform;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return event.operation_type === "CONSIGNMENT" ? consignmentPlatform(order) : null;
}

function eventIsUnlisted(order: AccountExecutionOrder, listingEvent: AccountExecutionEvent): boolean {
  return (order.events ?? []).some((event) => (
    event.event_type === "OPERATE"
    && event.operation_type === "UNLIST"
    && String(eventExtra(event).consignment_event_id ?? "") === String(listingEvent.id)
  ));
}

function eventListing(order: AccountExecutionOrder, event: AccountExecutionEvent): ConsignmentListing | null {
  const platform = eventPlatform(event, order);
  if (!platform || eventIsUnlisted(order, event) || order.status === "CANCELLED") return null;
  const extra = eventExtra(event);
  return {
    orderId: order.order_id,
    orderNo: order.order_no,
    eventId: event.id,
    platform,
    price: (extra.consignment_price as number | string | undefined) ?? null,
    listedAt: formatDateTimeMinute(String(extra.listed_at ?? event.occurred_at ?? event.occurred_on ?? "")),
  };
}

/** 返回当前仍在平台上的寄售记录。 */
export function activeConsignmentListings(order: AccountExecutionOrder): ConsignmentListing[] {
  const eventListings = (order.events ?? [])
    .filter((event) => event.event_type === "OPERATE" && event.operation_type === "CONSIGNMENT")
    .map((event) => eventListing(order, event))
    .filter((item): item is ConsignmentListing => Boolean(item));
  return eventListings;
}

export function consignmentListings(orders: AccountExecutionOrder[]): ConsignmentListing[] {
  return orders.flatMap(activeConsignmentListings);
}

/** 订单是否有寄售记录（包含已下架历史）。 */
export function isConsignmentListing(order: AccountExecutionOrder): boolean {
  return (order.events ?? []).some((event) => event.event_type === "OPERATE" && event.operation_type === "CONSIGNMENT");
}

/** 订单是否仍有当前寄售上架记录。 */
export function isActiveConsignmentListing(order: AccountExecutionOrder): boolean {
  return activeConsignmentListings(order).length > 0;
}

export function hasUnlistedConsignment(order: AccountExecutionOrder): boolean {
  const hasEventHistory = (order.events ?? []).some((event) => event.event_type === "OPERATE" && event.operation_type === "CONSIGNMENT");
  const hasUnlistEvent = (order.events ?? []).some((event) => event.event_type === "OPERATE" && event.operation_type === "UNLIST");
  return hasEventHistory && hasUnlistEvent;
}
