import { customersApi } from "./customers.api";
import type { Customer } from "./types/customers";

/** 分页读取全部符合条件的客户。 */
export async function loadCustomers(status?: string): Promise<Customer[]> {
  const customers: Customer[] = [];
  const limit = 500;
  while (true) {
    const page = await customersApi.page({ ...(status ? { status } : {}), limit, offset: customers.length });
    if (!page.items.length) {
      if (customers.length < page.total) throw new Error("客户名单读取不完整，请重试");
      return customers;
    }
    customers.push(...page.items);
    if (customers.length >= page.total) return customers;
  }
}
