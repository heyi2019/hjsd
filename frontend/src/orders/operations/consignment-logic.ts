import type { AccountExecutionEvent, AccountExecutionOrder } from "../../shared/api/types/account-execution";
import { formatDateTimeMinute } from "../../shared/lib/format";

/** 寄售记录：寄售是原订单上的 OPERATE 事件，不是单独的 DG 订单。 */
export type ConsignmentListing = {
  /** 同一订单可多次在同一平台上架，下架定位必须精确到该条运营事件。 */
  id: string;
  orderId: number;
  orderNo: string;
  eventId?: number;
  platform: string;
  price: number | string | null;
  listedAt: string;
};

function platformValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function eventPlatforms(event: AccountExecutionEvent): string[] {
  const configured = event.form_extra ?? {};
  return platformValues(configured.consignment_platforms);
}

/** 返回当前订单寄售事件记录的平台；寄售不读取订单类型或订单扩展字段。 */
export function consignmentPlatform(order: AccountExecutionOrder): string | null {
  const event = (order.events ?? []).find((item) => item.event_type === "OPERATE" && item.operation_type === "CONSIGNMENT");
  const configured = event?.form_extra?.consignment_platforms;
  const values = platformValues(configured);
  return values.length ? values.join("、") : null;
}

function eventExtra(event: AccountExecutionEvent): Record<string, unknown> {
  return event.form_extra ?? {};
}

function eventIsUnlisted(order: AccountExecutionOrder, listingEvent: AccountExecutionEvent, platform: string): boolean {
  return (order.events ?? []).some((event) => (
    event.event_type === "OPERATE"
    && event.operation_type === "UNLIST"
    && String(eventExtra(event).consignment_event_id ?? "") === String(listingEvent.id)
    && (eventExtra(event).platform_unlist_scope === "SYSTEM" || platformValues(eventExtra(event).consignment_platforms).includes(platform))
  ));
}

function eventListings(order: AccountExecutionOrder, event: AccountExecutionEvent): ConsignmentListing[] {
  const platforms = eventPlatforms(event);
  if (!platforms.length || order.status === "CANCELLED") return [];
  const extra = eventExtra(event);
  return platforms
    .filter((platform) => !eventIsUnlisted(order, event, platform))
    .map((platform) => ({
      id: `${order.order_id}:${event.id}:${platform}`,
      orderId: order.order_id,
      orderNo: order.order_no,
      eventId: event.id,
      platform,
      price: (extra.consignment_price as number | string | undefined) ?? null,
      listedAt: formatDateTimeMinute(String(extra.listed_at ?? event.occurred_at ?? event.occurred_on ?? "")),
    }));
}

/** 返回当前仍在平台上的寄售记录。 */
export function activeConsignmentListings(order: AccountExecutionOrder): ConsignmentListing[] {
  const listings = (order.events ?? [])
    .filter((event) => event.event_type === "OPERATE" && event.operation_type === "CONSIGNMENT")
    .flatMap((event) => eventListings(order, event));
  return listings;
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
