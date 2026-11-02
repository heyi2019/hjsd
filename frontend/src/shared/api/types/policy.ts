/** 政策定义/版本、分润比例与路由影响预览。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface PolicyDefinition {
  id: number;
  policy_code: string;
  name: string;
  scope_type: string;
  scope_id?: number | null;
  description?: string | null;
  status: string;
  created_at?: string | null;
}

export interface PolicyVersion {
  id: number;
  policy_definition_id: number;
  version: number;
  effective_from: string;
  effective_to?: string | null;
  config: Record<string, unknown>;
  status: string;
  approved_by?: string | null;
  approved_at?: string | null;
  note?: string | null;
}

export interface ProfitAllocation {
  id: number;
  order_id: number;
  user_id?: number | null;
  role: string;
  allocation_type?: "BUY" | "SELL" | "OPERATION" | "COMPANY" | null;
  allocation_rate: string;
  allocation_amount?: string;
  policy_version_id?: number | null;
  total_rate?: string;
  total_amount?: string;
}

export interface RouteImpactPreview { changed: boolean; historical_impact: Record<string, unknown>; future_effect: string }
