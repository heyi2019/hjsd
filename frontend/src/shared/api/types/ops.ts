/** 审计日志。
 * 按领域拆分的独立类型模块；从本文件路径直接导入。
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
