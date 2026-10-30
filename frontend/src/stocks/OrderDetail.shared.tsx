import { Descriptions, Typography } from "antd";
import type { ReactNode } from "react";
import type { Account, AccountExecutionEvent, EmployeeOption } from "../shared/api/catalog";

export type InventoryFinanceRow = {
  key: string;
  type: string;
  direction: "支出" | "收入";
  amount: string;
  rate: string;
  occurredAt: string;
  poolName: string;
  operator: string;
  event?: AccountExecutionEvent | null;
};

export type InventoryExecutionCategory = "BUY_IN" | "OPERATING" | "SELL_OUT";

export const OPERATION_CATEGORY_LABEL: Record<InventoryExecutionCategory, string> = {
  BUY_IN: "买号入库",
  OPERATING: "账号运营",
  SELL_OUT: "卖号出库",
};

/** 操作明细按事件类型归三类：买号入库(BUY) / 卖号出库(SELL) / 其余归账号运营（寄售、下架、提号、成本、回款、取消等）。 */
export function classifyEventCategory(eventType: string | null | undefined): InventoryExecutionCategory {
  if (eventType === "BUY") return "BUY_IN";
  if (eventType === "SELL") return "SELL_OUT";
  return "OPERATING";
}

export type InventoryExecutionRow = {
  key: string;
  category: InventoryExecutionCategory;
  action: string;
  occurredAt: string;
  operator: string;
  amount: string;
  note: string;
  event: AccountExecutionEvent;
};

export type InventoryPartyLink = {
  id: number;
  display_name: string;
  role: string;
  entityType: "customer" | "counterparty";
};

export type OrderDetailField = { key: string; label: string; value: ReactNode; className?: string };

/** 表单字段配置 section 的展示标题（与后端 OrderFormField.section / 前端 CUSTOM_SECTION_LABEL 对齐）。 */
export const ORDER_FIELD_SECTION_LABEL: Record<string, string> = {
  ACCOUNT_PRODUCT: "账号 / 产品补充信息",
  BUSINESS: "业务方案补充信息",
  DELIVER: "交付补充信息",
  OPERATION: "运营信息",
  PARTICIPANT: "参与方信息",
  FINANCE: "费用与资金补充信息",
  EXTRA: "其他补充信息",
};

export type OrderDetailMeta = {
  // 基本资料（来自 account 行）
  inventoryNo?: string;
  status?: string;
  statusLabel?: string;
  gameType?: string | null;
  gameAccount?: string | null;
  platform?: string | null;
  cost?: string | null;
  businessMode?: string | null;
  inventoryType?: string | null;
  valueAddedService?: string | null;
  // 注册与流转信息
  orderNo: string;
  createdBy: string;
  registeredAt: string;
  soldAt: string;
  removedAt: string;
  recoveryPlatform: string;
  salePlatform: string;
  consignmentSummary: string;
  // 账号补充资料
  password: string;
  channelRegion: string;
  boundPhone: string;
  secondary: string;
  showProfileFields: boolean;
  accountDescription: string;
  accountImages: string[];
  note: string;
  // 订单补充
  orderNotes: string;
  orderParties: ReactNode;
  orderExtras: Array<{ key: string; label: string; value: string; section: string }>;
  // 运营状态（板块3 展示）
  operationStatusLabel: string;
  hasActiveConsignment: boolean;
};

/** 编辑态下单个事件的草稿值，由上层 InventoryPanel 持有。 */
export type InventoryEventDraft = { amount: string; note: string | null; operator_user_ids?: number[] };
export type InventoryEmployeeOption = EmployeeOption;

const EDITABLE_CASHFLOW_EVENTS = new Set(["BUY", "SELL", "COST"]);

export function isEditableCashflowEvent(event: AccountExecutionEvent): boolean {
  return Boolean(event.cashflow && EDITABLE_CASHFLOW_EVENTS.has(event.event_type));
}

/** 订单自定义字段按 section 分组渲染；无字段时整组不渲染（保持原行为）。 */
export function InventoryExtraFieldsGroup({ section, fields }: { section: string; fields: OrderDetailField[] }) {
  if (!fields.length) return null;
  return (
    <div className="inventory-detail__meta-group">
      <div className="inventory-detail__meta-group-title">{ORDER_FIELD_SECTION_LABEL[section] ?? section}</div>
      <Descriptions className="inventory-detail__meta-table" size="small" bordered column={4}>
        {fields.map((field) => <Descriptions.Item key={field.key} label={field.label}>{field.value}</Descriptions.Item>)}
      </Descriptions>
    </div>
  );
}

/** 编辑态才出现的板块内标题。只读态标题由 Tab 标签承载，板块内不重复。 */
export function InventorySectionHeading({ title }: { title: ReactNode }) {
  return <div className="inventory-detail__section-heading"><Typography.Text strong>{title}</Typography.Text></div>;
}
