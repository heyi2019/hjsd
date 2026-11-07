/**
 * 接口聚合桶：catalog.ts 已按业务域拆分为 types.ts + *.api.ts。
 * 本文件仅做再导出兼容层；历史 `import { xApi } from "../shared/api/catalog"` 与 `import * as catalog` 仍可用。
 */
export * from "./types";
export * from "./pools.api";
export * from "./orders.api";
export * from "./customers.api";
export * from "./stocks.api";
export * from "./installments.api";
export * from "./cashflows.api";
export * from "./rebates.api";
export * from "./org.api";
export * from "./options.api";
export * from "./reports.api";
export * from "./policy.api";
export * from "./misc.api";
