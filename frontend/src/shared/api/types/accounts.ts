/** 库存账号主档与库存统计。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface Account {
  id: number;
  stock_no?: string | null;
  source_order_id?: number | null;
  source_order_no?: string | null;
  game_type?: string | null;
  business_mode?: string | null;
  inventory_type?: string | null;
  value_added_service?: string | null;
  game_account?: string | null;
  game_password?: string | null;
  /** 营地账号：账号绑定的官方社区（营地）账号，随号交付，不参与核算。 */
  camp_account?: string | null;
  channel_region?: string | null;
  bound_phone?: string | null;
  bound_phone_owner?: string | null;
  has_secondary?: boolean | null;
  /** 二次验证佐证图（data URL，最多 3 张）。 */
  secondary_images?: string[] | null;
  /** 钱包实名：未注销 / 已注销（账号交付前需确认实名是否已解绑）。 */
  wallet_realname?: string | null;
  /** 钱包实名已注销佐证图（data URL，最多 3 张）。 */
  wallet_realname_images?: string[] | null;
  account_description?: string | null;
  account_images?: string[] | null;
  extra_values?: Record<string, unknown>;
  note?: string | null;
  platform?: string | null;
  status: string;
  inventory_status?: string;
  inventory_entry_at?: string | null;
  inventory_operator?: string | null;
  cost_amount: string;
  buy_date?: string | null;
  created_by: string;
  created_at?: string | null;
  /** 在库天数（自然日，后端算）：非在库为 null，前端只展示。 */
  inventory_age_days?: number | null;
  /** 库龄档位：NORMAL ≤7 天 / WARNING ≤30 天 / OVERDUE >30 天。 */
  inventory_age_level?: "NORMAL" | "WARNING" | "OVERDUE" | null;
}

/**
 * 库存卡片指标：由后端按「当前可见的账号集合」汇总。
 * `account_count` 是后端实际命中的集合大小（可见范围过滤后），用于核对前后端口径。
 */
export interface InventoryStats {
  account_count: number;
  occupied_cost: string;
  over_7d_count: number;
  over_30d_count: number;
}
