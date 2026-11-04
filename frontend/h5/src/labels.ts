/**
 * H5 文案与语义常量。
 *
 * 集中在同一处的原因：首页与业务页各自写过一份 STATUS_LABEL，两份都只覆盖
 * DRAFT/CONFIRMED/COMPLETED/CANCELLED/VOID，而线上真实状态是
 * ACTIVE / INSTALLMENT —— 于是列表上直接露出英文枚举。这里按后端
 * app/domain/enums.py 的 OrderStatus 补齐，未知值一律回落「处理中」，
 * 宁可含糊也不把英文糊到用户脸上。
 *
 * 色调（tone）只做辅助，语义由文案承载（与桌面端 StatusTag 同一原则）。
 * 桌面端色值映射是 antd 预设色（green/cyan/blue…），移动端改用语义色，
 * 因此两侧同一状态的色相可能不同，这是有意为之：移动端以「一眼分得清」优先。
 */

export type Tone = "blue" | "green" | "purple" | "orange" | "red" | "gray";

/** 订单状态（OrderStatus） */
export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  CONFIRMED: "已确认",
  ACTIVE: "进行中",
  INSTALLMENT: "分期中",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  VOID: "已失效",
};

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: "gray",
  CONFIRMED: "blue",
  ACTIVE: "blue",
  INSTALLMENT: "purple",
  COMPLETED: "green",
  CANCELLED: "gray",
  VOID: "gray",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? "处理中";
}

export function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? "gray";
}

/** 业务类型（contract_type） */
export const ORDER_TYPE_LABEL: Record<string, string> = {
  HS: "回收销售",
  TH: "提号销售",
  DG: "代挂",
};

/** 行首方形图标里的单字：图标方块比「HS」灰标签信息量更高，也不会与单号前缀重复 */
const ORDER_TYPE_GLYPH: Record<string, string> = {
  HS: "回",
  TH: "提",
  DG: "挂",
};

const ORDER_TYPE_TONE: Record<string, Tone> = {
  HS: "blue",
  TH: "purple",
  DG: "orange",
};

export function orderTypeLabel(type: string): string {
  return ORDER_TYPE_LABEL[type] ?? type;
}

/** 合约类型（contract_type）与业务类型（order_type）是两套编码：
 *  HS/TH/DG 是 order_type，STOCK_SALE/PICKUP_SALE/CONSIGNMENT_SALE 是 contract_type。
 *  分期列表下发的是后者，直接用 orderTypeLabel 会露出英文枚举。 */
export const CONTRACT_TYPE_LABEL: Record<string, string> = {
  STOCK_SALE: "回收销售",
  PICKUP_SALE: "提号销售",
  CONSIGNMENT_SALE: "代挂",
};

export function contractTypeLabel(type: string): string {
  return CONTRACT_TYPE_LABEL[type] ?? ORDER_TYPE_LABEL[type] ?? "—";
}

export function orderTypeGlyph(type: string): string {
  return ORDER_TYPE_GLYPH[type] ?? "单";
}

export function orderTypeTone(type: string): Tone {
  return ORDER_TYPE_TONE[type] ?? "gray";
}

/** 角色 */
export const ROLE_LABEL: Record<string, string> = {
  ADMIN: "管理员",
  OPERATOR: "经办人",
  FINANCE: "财务",
  AUDITOR: "审核",
  VIEWER: "只读",
};

// ---------------------------------------------------------------- 其它域状态
// 一律照后端 app/domain/enums.py 对齐；新增枚举时先改这里，别在页面里就地写死。

/** 库存账号（AccountStatus） */
export const STOCK_STATUS_LABEL: Record<string, string> = {
  WAITING: "待售",
  SOLD: "已售",
  VOID: "已失效",
};

const STOCK_STATUS_TONE: Record<string, Tone> = {
  WAITING: "orange",
  SOLD: "green",
  VOID: "gray",
};

/** 资金流水（CashflowStatus） */
export const CASHFLOW_STATUS_LABEL: Record<string, string> = {
  PENDING: "待审核",
  APPROVED: "已审核",
  REJECTED: "已驳回",
};

const CASHFLOW_STATUS_TONE: Record<string, Tone> = {
  PENDING: "orange",
  APPROVED: "green",
  REJECTED: "red",
};

/** 分期合约（InstallmentStatus） */
export const INSTALLMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "待生效",
  ACTIVE: "还款中",
  OVERDUE: "逾期",
  SETTLED: "已结清",
  DELIVERED: "已交付",
  DEFAULTED: "已违约",
  CLOSED: "已关闭",
  CANCELLED: "已取消",
};

const INSTALLMENT_STATUS_TONE: Record<string, Tone> = {
  PENDING: "gray",
  ACTIVE: "blue",
  OVERDUE: "red",
  SETTLED: "green",
  DELIVERED: "blue",
  DEFAULTED: "red",
  CLOSED: "gray",
  CANCELLED: "gray",
};

/** 客户（CustomerStatus） */
export const CUSTOMER_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "正常",
  DISABLED: "已停用",
  MERGED: "已合并",
};

export function stockStatusLabel(value: string): string {
  return STOCK_STATUS_LABEL[value] ?? "未知";
}

export function stockStatusTone(value: string): Tone {
  return STOCK_STATUS_TONE[value] ?? "gray";
}

export function cashflowStatusLabel(value: string): string {
  return CASHFLOW_STATUS_LABEL[value] ?? "未知";
}

export function cashflowStatusTone(value: string): Tone {
  return CASHFLOW_STATUS_TONE[value] ?? "gray";
}

export function installmentStatusLabel(value: string): string {
  return INSTALLMENT_STATUS_LABEL[value] ?? "未知";
}

export function installmentStatusTone(value: string): Tone {
  return INSTALLMENT_STATUS_TONE[value] ?? "gray";
}

export function customerStatusLabel(value: string): string {
  return CUSTOMER_STATUS_LABEL[value] ?? "未知";
}

/** 分期与账期里的大量日期都是「年月日」，列表里保留完整格式更好对齐 */
export function dayOf(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "—";
}

// ---------------------------------------------------------------- 金额

export function money(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "0.00";
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num)
    ? num.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(value);
}

/** 主视觉卡里的总额：超过一万按「万」显示，避免 34px 大字被撑出屏幕 */
export function moneyWan(value: number): { text: string; unit: string } {
  if (!Number.isFinite(value)) return { text: "—", unit: "" };
  const abs = Math.abs(value);
  if (abs >= 1_0000_0000) return { text: (value / 1_0000_0000).toFixed(2), unit: "亿" };
  if (abs >= 10000) return { text: (value / 10000).toFixed(2), unit: "万" };
  return { text: money(value), unit: "" };
}

/** 日期：2026-11-05 → 11-05（列表行里年份是噪音，今年的单子占绝大多数） */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.length >= 10 ? iso.slice(5, 10) : iso;
}

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "夜深了";
  if (hour < 9) return "早上好";
  if (hour < 12) return "上午好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 利润涨跌色：正绿负红，零值不着色（不退成灰色文字，避免与「无数据」混淆）。 */
export function profitClass(value: string | number | null | undefined): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num === 0) return "";
  return num > 0 ? "h5-row__profit--up" : "h5-row__profit--down";
}
