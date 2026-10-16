export type BusinessCenterTab = "inventory" | "ledger" | "collections";

/** 当前唯一需要从其他页面直达的业务中心入口。 */
export type BusinessCenterEntryTab = "inventory";

export const DEFAULT_BUSINESS_CENTER_TAB: BusinessCenterTab = "ledger";
