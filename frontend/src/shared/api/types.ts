/** 全部 v1 接口 DTO 类型定义（统一出口）。
 * 实体按领域拆到 ./types/*.ts，这里只做 re-export：调用方继续 `from "../shared/api/types"` 即可。
 * 路径以后端 `/api/v1` 实际路由为准；金额一律以字符串传输，前端不做浮点数计算。 */

export * from "./types/common";
export * from "./types/org";
export * from "./types/customers";
export * from "./types/orders";
export * from "./types/order-events";
export * from "./types/accounts";
export * from "./types/account-execution";
export * from "./types/installments";
export * from "./types/finance";
export * from "./types/forms";
export * from "./types/reporting";
export * from "./types/policy";
export * from "./types/imports";
export * from "./types/ops";
