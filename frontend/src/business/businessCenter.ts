export type BusinessCenterTab = "inventory" | "ledger" | "collections";

/** 业务中心只承载库存、订单台账与分期回款等作业页；业务总览归入工作台。 */
export type BusinessCenterEntryTab = BusinessCenterTab;

export const DEFAULT_BUSINESS_CENTER_TAB: BusinessCenterTab = "inventory";
