/** 经营报表行（库存健康、月度损益、提成、业务损益、日资金、订单利润）。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface InventoryHealthRow {
  account_id: number;
  game_account?: string | null;
  platform?: string | null;
  business?: string | null;
  status: string;
  buy_amount: string;
  expected_price?: string | null;
  expected_profit?: string | null;
  extra_cost: string;
  total_cost: string;
  holding_days?: number | null;
  owner_id?: number | null;
}

export interface InventoryHealthReport {
  generated_on: string;
  total_cost: string;
  items: InventoryHealthRow[];
}

export interface MonthlyPnlRow {
  month: string;
  sales_income: string;
  account_direct_cost: string;
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
  user_id: number;
  order_id: number;
  order_no: string;
  profit_base: string;
  rate: string;
  payable: string;
  paid: string;
  difference: string;
}

export interface CommissionGroup {
  user_id: number;
  order_count: number;
  profit_base: string;
  payable: string;
  paid: string;
  difference: string;
  orders: CommissionRow[];
}

export interface CommissionReport {
  total: { order_count: number; profit_base: string; payable: string; paid: string; difference: string };
  items: CommissionRow[];
  groups?: CommissionGroup[];
}

export interface BusinessPnlRow {
  business_mode?: string | null;
  business_type?: string | null;
  order_type: string;
  order_count?: number;
  main_income: string;
  main_cost: string;
  main_profit: string;
  settled_rebate: string;
  uncollected_rebate: string;
  full_income: string;
}

export interface BusinessPnlReport {
  total: Omit<BusinessPnlRow, "order_type">;
  items: BusinessPnlRow[];
}

export interface DailyFundsRow {
  pool_code: string;
  pool_name: string;
  opening: string;
  income: string;
  expense: string;
  deposit_paid: string;
  deposit_held: string;
  cash_balance: string;
  available: string;
}

export interface DailyFundsReport {
  date: string;
  total: Omit<DailyFundsRow, "pool_code" | "pool_name">;
  items: DailyFundsRow[];
}

export interface OrderProfitRow {
  order_id: number;
  order_no: string;
  order_type: string;
  trade_date: string;
  status: string;
  income: string;
  buy_amount: string;
  direct_cost: string;
  rebate: string;
  net_profit: string;
}

export interface OrderProfitReport {
  from?: string | null;
  to?: string | null;
  total: { income: string; buy_amount: string; direct_cost: string; rebate: string; net_profit: string };
  items: OrderProfitRow[];
}
