/** 经营报表行（月度损益、分润、业务损益、日资金、订单利润）。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface MonthlyPnlRow {
  month: string;
  sales_income: string;
  studio_other_income: string;
  cost: string;
  operating_expense: string;
  rebate_income: string;
  operating_profit: string;
}

export interface MonthlyPnlReport {
  from?: string | null;
  to?: string | null;
  total: Omit<MonthlyPnlRow, "month">;
  items: MonthlyPnlRow[];
}

export interface CommissionRow {
  user_id: number | null;
  user_name: string | null;
  order_id: number;
  order_no: string;
  inventory_date?: string | null;
  outbound_date?: string | null;
  profit_base: string;
  rate: string;
}

export interface CommissionOrderGroup {
  order_id: number;
  order_no: string;
  inventory_date?: string | null;
  outbound_date?: string | null;
  profit_base: string;
  personnel_profit_base: string;
  orders: CommissionRow[];
}

export interface CommissionReport {
  total: { order_count: number; profit_base: string };
  order_groups: CommissionOrderGroup[];
  people: { user_id: number; user_name: string; is_active: boolean }[];
}

export interface BusinessPnlRow {
  business_mode?: string | null;
  business_type?: string | null;
  order_type: string;
  order_count?: number;
  main_income: string;
  cost: string;
  main_profit: string;
}

export interface BusinessPnlReport {
  total: Omit<BusinessPnlRow, "order_type">;
  items: BusinessPnlRow[];
}

export interface DataCenterSummary {
  order_count: number;
  active_order_count: number;
  sold_cost: string;
  in_transit_cost: string;
  deposit_held: string;
  studio_cost: string;
  account_sale_profit: string;
  studio_other_income: string;
  profit: string;
}

export interface OrderProfitRow {
  order_id: number;
  order_no: string;
  order_type: string;
  trade_date: string;
  status: string;
  income: string;
  cost: string;
  rebate: string;
  net_profit: string;
}

export interface OrderProfitReport {
  from?: string | null;
  to?: string | null;
  total: { income: string; cost: string; rebate: string; net_profit: string };
  items: OrderProfitRow[];
}
