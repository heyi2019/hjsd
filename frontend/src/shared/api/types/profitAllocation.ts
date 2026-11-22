/** 订单利润分润比例与汇总。金额一律以字符串传输，前端不做浮点数计算。 */

export interface ProfitAllocation {
  id: number;
  order_id: number;
  user_id?: number | null;
  role: string;
  allocation_type?: "BUY" | "SELL" | "OPERATION" | "COMPANY" | null;
  allocation_rate: string;
  allocation_amount?: string;
  total_rate?: string;
  total_amount?: string;
}

export type ProfitAllocationType = "BUY" | "SELL" | "OPERATION" | "COMPANY";

export interface ProfitAllocationTypeTotal {
  allocation_rate: string;
  allocation_amount: string;
}

export interface ProfitAllocationList {
  items: ProfitAllocation[];
  total: number;
  order_profit: string;
  company_rate: string;
  allocatable_profit: string;
  totals_by_type: Partial<Record<ProfitAllocationType, ProfitAllocationTypeTotal>>;
}
