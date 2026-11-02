/** 移动端（H5）组件层统一出口。
 *
 * 一条约定：**这个目录只放「怎么在小屏上摆」，不放取数与业务规则**。
 * 业务口径仍从各自域取（如库龄取 `stocks/inventory-logic`），避免移动端另长一套算法。
 *
 * 挂载条件：各业务页用 `useCompactLayout()` 判定，桌面分支不挂载这些组件，
 * 所以桌面表格、jsdom 单测都不受影响。
 */
export * from "./customers";
export * from "./installments";
export * from "./orders";
export * from "./pools";
export * from "./reporting";
export * from "./stocks";
