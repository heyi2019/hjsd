/** 审计日志、质量工单与质量指标。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface AuditLogRow {
  id: number;
  actor?: string | null;
  action?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  occurred_at?: string | null;
}

export interface AuditEntityStat {
  entity_type: string;
  /** 真实累计条数（COUNT(*)） */
  count: number;
  last_at?: string | null;
  last_actor?: string | null;
}

export interface QualityIssue { id: number; issue_no: string; severity: string; title: string; entity_type: string; entity_id: string; status: string; message: string }

export interface QualitySummary { total: number; by_severity: Record<string, number> }

export interface QualityMetricValue {
  rate: number | null;
  numerator: number | null;
  denominator: number | null;
  amount: string | null;
}

export interface QualityMetricDefinition { label: string; formula: string; unit: string }

export interface QualityMetricRow {
  month: string;
  reconciliation_completion_rate: QualityMetricValue;
  overdue_rate: QualityMetricValue;
  missing_attachment_rate: QualityMetricValue;
}

export interface QualityMetrics {
  from: string;
  to: string;
  definitions: Record<string, QualityMetricDefinition>;
  items: QualityMetricRow[];
}
