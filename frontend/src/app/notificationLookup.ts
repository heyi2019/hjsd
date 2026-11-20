import { notificationsApi } from "../shared/api/misc.api";
import { ordersApi } from "../shared/api/orders.api";
export async function findPendingProfitNotification() {
  const page = await notificationsApi.list({ limit: 1, unread_only: true, notification_type: "PROFIT_PENDING", entity_type: "order" });
  if (!page.items.length && page.total > 0) throw new Error("通知读取不完整，请重试");
  return page.items[0];
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
