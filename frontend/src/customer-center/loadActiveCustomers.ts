import { loadCustomers } from "../shared/api/loadCustomers";

/** 读取全部可见的有效客户。 */
export const loadActiveCustomers = () => loadCustomers("ACTIVE");
