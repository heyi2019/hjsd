/** 分期文案常量（移动端卡片已迁至 src/h5/installments.tsx）。 */
/** 合约类型页签与违约处置文案的回落值；词典加载后由选项词典接管（改造前即为这些文案）。 */
export const CONTRACT_TYPE_LABEL: Record<string, string> = {
  STOCK_SALE: "分期出售",
};
export const DISPOSITION_LABEL: Record<string, string> = {
  RECOVER: "回收",
  RESELL: "出售",
};

/** 期次状态与合约状态取值不同（PENDING/PARTIAL/PAID/OVERDUE/WAIVED），单独映射，避免复用合约标签出现裸英文。 */
export const SCHEDULE_STATUS_LABEL: Record<string, string> = {
  PENDING: "待收",
  PARTIAL: "部分收款",
  PAID: "已收",
  OVERDUE: "逾期",
  WAIVED: "已减免",
};

