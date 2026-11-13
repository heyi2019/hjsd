/** 订单主档与订单挂载的流水/返点/分期/排期行。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

import type { OrderAttachment, OrderAuditEntry, OrderEvent, OrderLink } from "./order-events";

export interface OrderType {
  id: number;
  code: string;
  name: string;
  capital_type: string;
  is_active: boolean;
  description?: string | null;
  sort_order?: number;
  sequence_prefix?: string | null;
}

export interface OrderTypeRoute {
  id: number;
  order_type_code: string;
  portion: string;
  fund_nature?: string | null;
  pool_code: string;
  pool_name: string;
  priority: number;
  is_active: boolean;
}

export interface Order {
  id: number;
  order_no: string;
  order_type: string;
  capital_type: string;
  business_mode?: string | null;
  business_type?: string | null;
  value_added_service?: string | null;
  trade_date: string;
  account_id?: number | null;
  stock_no?: string | null;
  status: string;
  note?: string | null;
  account_game_type?: string | null;
  account_game_account?: string | null;
  account_channel_region?: string | null;
  account_business_mode?: string | null;
  account_platform?: string | null;
  account_status?: string | null;
  party_name?: string | null;
  party_role?: string | null;
  party_source?: string | null;
  party_created_by?: string | null;
  party_created_at?: string | null;
  inventory_entry_at?: string | null;
  inventory_operator?: string | null;
  sale_at?: string | null;
  sale_operator?: string | null;
  in_hand_time?: string | null;
  event_total?: string | null;
  sale_amount?: string | null;
  cost_amount?: string | null;
  profit_base?: string | null;
  last_event_type?: string | null;
  last_event_amount?: string | null;
  last_event_on?: string | null;
  installment_principal?: string | null;
  installment_paid?: string | null;
  installment_periods?: number | null;
  installment_status?: string | null;
  events?: OrderEvent[];
  links?: OrderLink[];
  cashflows?: OrderCashflow[];
  rebates?: OrderRebate[];
  installment?: OrderInstallment | null;
  installment_schedule?: OrderScheduleRow[];
  audit?: OrderAuditEntry[];
  attachments?: OrderAttachment[];
  /** 自定义扩展字段历史值（按 field_key 归集）；删除/停用字段的值仍保留在此，详情展示时兜底。 */
  form_extra?: Record<string, unknown>;
  /** 建单时的账号文本快照（无 order.create 权限时 game_password 被后端置空）。 */
  account_snapshot?: {
    game_account: string;
    game_type?: string | null;
    game_password?: string | null;
    camp_account?: string | null;
    channel_region?: string | null;
    bound_phone?: string | null;
    bound_phone_owner?: string | null;
    has_secondary?: boolean | null;
    /** 二次验证佐证图（data URL，最多 3 张）；仅「有无二次」为有时的上传结果。 */
    secondary_images?: string[] | null;
    wallet_realname?: string | null;
    /** 钱包实名已注销佐证图（data URL，最多 3 张）。 */
    wallet_realname_images?: string[] | null;
    platform?: string | null;
    purchase_price?: string | null;
    note?: string | null;
  } | null;
  /** 关联完整性：NORMAL / ORPHAN / UNLINKED_TRANSFER（后端 orders/schemas.py）。 */
  link_status?: string;
}

export interface OrderCashflow {
  flow_no: string;
  pool_id: number;
  occurred_on: string;
  occurred_at?: string | null;
  nature: string;
  category: string;
  direction: string;
  amount: string;
  status: string;
  order_event_id?: number | null;
  note?: string | null;
  operator: string;
}

export interface OrderRebate {
  id: number;
  rebate_no: string;
  rebate_type: string;
  channel?: string | null;
  rate: string;
  base_amount: string;
  link_status: string;
  status: string;
  collected_on: string;
  note?: string | null;
  created_at?: string;
  operator: string;
}

export interface OrderInstallment {
  id: number;
  inst_no: string;
  order_id: number;
  contract_type: string;
  principal: string;
  down_payment: string;
  service_fee: string;
  periods: number;
  per_period_service_fee: string;
  per_period: string;
  paid_amount: string;
  waived_amount: string;
  bad_debt_amount: string;
  status: string;
  delivery_mode?: string | null;
  delivered_on?: string | null;
  first_due_on?: string | null;
  note?: string | null;
}

export interface OrderScheduleRow {
  id: number;
  installment_id: number;
  period_no: number;
  due_on: string;
  due_amount: string;
  received_amount: string;
  waived_amount: string;
  status: string;
}
