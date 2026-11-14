/** 审计日志。
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
