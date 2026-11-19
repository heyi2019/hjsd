import { notificationsApi } from "../shared/api/misc.api";
import { ordersApi } from "../shared/api/orders.api";
import type { NotificationItem } from "../shared/api/types/common";

export async function loadProfitNotifications(notificationType: string): Promise<NotificationItem[]> {
  const items: NotificationItem[] = [];
  while (true) {
    const page = await notificationsApi.list({ limit: 200, unread_only: true, notification_type: notificationType, ...(items.length ? { offset: items.length } : {}) });
    if (!page.items.length && page.total !== undefined && items.length < page.total) throw new Error("通知读取不完整，请重试");
    items.push(...page.items);
    if (page.total !== undefined ? items.length >= page.total : page.items.length < 200) return items;
  }
}

export async function findOrderByNumber(orderNo: string) {
  let offset = 0;
  while (true) {
    const page = await ordersApi.listPage({ keyword: orderNo, limit: 20, offset });
    const order = page.items.find((item) => item.order_no === orderNo);
    if (order) return order;
    offset += page.items.length;
    if (!page.items.length || offset >= page.total) return undefined;
  }
}
