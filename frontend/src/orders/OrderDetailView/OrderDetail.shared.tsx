import { Typography } from "antd";
import type { ReactNode } from "react";
import type { AccountExecutionEvent } from "../../shared/api/types/account-execution";
import type { EmployeeOption } from "../../shared/api/types/org";

export const PARTY_ROLE_LABEL: Record<string, string> = {
  SELLER: "卖家",
  BUYER: "买家",
  CONSIGNOR: "寄售方",
  PEER: "同行",
  SUPPLIER: "供货方",
  PLATFORM: "平台",
  INSTALLMENT_CUSTOMER: "分期客户",
};

export type InventoryFinanceRow = {
  key: string;
  flowNo: string;
  type: string;
  direction: "支出" | "收入";
  amount: string;
  occurredAt: string;
  poolName: string;
  note: string;
  operator: string;
  event?: AccountExecutionEvent | null;
};

export type InventoryOperationRow = {
  key: string;
  action: string;
  content: ReactNode;
  occurredAt: string;
  operator: string;
  event?: AccountExecutionEvent;
};

export type InventoryExecutionCategory = "INBOUND" | "OPERATING" | "OUTBOUND";

export const OPERATION_CATEGORY_LABEL: Record<InventoryExecutionCategory, string> = {
  INBOUND: "账号入库",
  OPERATING: "账号运营",
  OUTBOUND: "账号出库",
};

/** 操作明细按账号生命周期归类：入库 / 运营 / 出库。 */
export function classifyEventCategory(eventType: string | null | undefined): InventoryExecutionCategory {
  if (eventType === "BUY") return "INBOUND";
  if (eventType === "SELL") return "OUTBOUND";
  return "OPERATING";
}

export type InventoryExecutionRow = {
  key: string;
  orderId: number;
  category: InventoryExecutionCategory;
  action: string;
  occurredAt: string;
  operator: string;
  amount: string;
  note: string;
  platform: string;
  /** 建单入库展示行没有对应的业务事件，不参与编辑和资金处理。 */
  event?: AccountExecutionEvent;
};

/** 编辑态的事件草稿是详情内所有事件视图的唯一实时来源。 */
export function resolveExecutionPlatform(
  fallback: string,
  event: Pick<AccountExecutionEvent, "event_type" | "operation_type" | "form_extra"> | null | undefined,
  draft?: Pick<InventoryEventDraft, "form_extra">,
): string {
  if (!event || event.event_type !== "OPERATE") return fallback || "-";

  const hasDraftExtra = draft?.form_extra !== undefined;
  const extra = hasDraftExtra ? (draft.form_extra ?? {}) : (event.form_extra ?? {});
  if (event.operation_type === "UNLIST" && extra.platform_unlist_scope === "SYSTEM") return "本系统";

  const platforms = extra.consignment_platforms;
  if (Array.isArray(platforms)) {
    const value = platforms.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).join("、");
    return value || (hasDraftExtra ? "-" : fallback || "-");
  }
  return hasDraftExtra ? "-" : fallback || "-";
}

export type InventoryPartyLink = {
  id: number;
  display_name: string;
  role: string;
  entityType: "customer" | "counterparty";
};

export type OrderDetailMeta = {
  // 基本资料（来自 account 行）
  orderId?: number;
  inventoryNo?: string;
  status?: string;
  statusLabel?: string;
  gameType?: string | null;
  gameAccount?: string | null;
  campAccount?: string | null;
  platform?: string | null;
  cost?: string | null;
  businessMode?: string | null;
  inventoryType?: string | null;
  valueAddedService?: string | null;
  // 注册与流转信息
  orderNo: string;
  sourceOrderNo?: string | null;
  createdBy: string;
  registeredAt: string;
  soldAt: string;
  removedAt: string;
  removedPlatform: string;
  recoveryPlatform: string;
  salePlatform: string;
  listedPlatform: string;
  listedAt: string;
  listedOperator: string;
  unlistedPlatform: string;
  unlistedAt: string;
  unlistedOperator: string;
  descriptionAt: string;
  descriptionOperator: string;
  imagesAt: string;
  imagesOperator: string;
  // 账号补充资料
  password: string;
  channelRegion: string;
  boundPhone: string;
  secondary: string;
  walletRealname: string;
  /** 钱包实名注销佐证图（data URL）。 */
  walletRealnameImages: string[];
  accountDescription: string;
  accountImages: string[];
  /** 二次验证佐证图（data URL）。 */
  secondaryImages: string[];
  note: string;
  // 订单补充
  orderNotes: string;
  orderParties: ReactNode;
  orderExtras: Array<{ key: string; label: string; value: string; section: string }>;
};

/** 编辑态下单个事件的草稿值，由上层 InventoryPanel 持有。 */
export type InventoryEventDraft = {
  amount: string;
  note: string | null;
  occurred_at: string;
  form_extra?: Record<string, unknown>;
  operator_user_ids?: number[];
};
export type InventoryEmployeeOption = EmployeeOption;

const EDITABLE_CASHFLOW_EVENTS = new Set(["BUY", "SELL"]);

export function isEditableCashflowEvent(event: AccountExecutionEvent): boolean {
  return Boolean(event.cashflow && EDITABLE_CASHFLOW_EVENTS.has(event.event_type));
}

/** 编辑态才出现的板块内标题。只读态标题由 Tab 标签承载，板块内不重复。 */
export function InventorySectionHeading({ title }: { title: ReactNode }) {
  return <div className="inventory-detail__section-heading"><Typography.Text strong>{title}</Typography.Text></div>;
}

