import { customersApi } from "../shared/api/customers.api";
import type { Customer } from "../shared/api/types/customers";

/** 分批获取全部可见的有效客户，避免选择器只显示第一页。 */
export async function loadActiveCustomers(): Promise<Customer[]> {
  const customers: Customer[] = [];
  const limit = 500;
  while (true) {
    const page = await customersApi.page({ status: "ACTIVE", limit, offset: customers.length });
    if (!page.items.length) {
      if (customers.length < page.total) throw new Error("客户名单读取不完整，请重试");
      return customers;
    }
    customers.push(...page.items);
    if (customers.length >= page.total) return customers;
  }
}
