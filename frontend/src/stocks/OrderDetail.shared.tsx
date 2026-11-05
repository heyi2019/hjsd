import { Descriptions, Typography } from "antd";
import type { ReactNode } from "react";
import type {
  Account,
  AccountExecutionDetail,
  AccountExecutionEvent,
  AccountExecutionOrder,
  EmployeeOption,
} from "../shared/api/catalog";

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
  platform: string;
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
  consignmentSummary: string;
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
  // 运营状态（板块3 展示）
  operationStatusLabel: string;
  hasActiveConsignment: boolean;
  // 运营操作人（只读态为空，编辑态由表单字段配置填充）
  operationOperators?: string;
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

/** 建单来源单：优先匹配 source_order_no，否则取首个非 DG（寄售）单，再回落首单。
 *  与「售出=统一动作」口径一致——账号资料/买号交付统一取创建（收购）单，而非代挂运营单。 */
export function findCreationOrder(
  detail?: AccountExecutionDetail | null,
  sourceOrderNo?: string | null,
): AccountExecutionOrder | undefined {
  if (!detail?.orders?.length) return undefined;
  return (
    detail.orders.find((order) => order.order_no === sourceOrderNo)
    ?? detail.orders.find((order) => order.order_type !== "DG")
    ?? detail.orders[0]
  );
}

/** 卖号交付单：优先取含 SELL 事件的单，否则取首个非创建单的 DG（代挂售出）单。无售出则为 undefined。 */
export function findSellOrder(
  detail?: AccountExecutionDetail | null,
  creationOrder?: AccountExecutionOrder,
): AccountExecutionOrder | undefined {
  if (!detail?.orders?.length) return undefined;
  return (
    detail.orders.find((order) => order.events.some((event) => event.event_type === "SELL"))
    ?? detail.orders.find((order) => order !== creationOrder && order.order_type === "DG")
    ?? undefined
  );
}
