/** 审计查询：按对象追溯操作记录，数据范围由后端权限控制。 */
import { Card, Input, Select } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { auditApi, type AuditLogRow } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { DataTable, ErrorBanner } from "../shared/ui";

export function AuditPanel() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const load = useCallback(async () => {
    try { const result = await auditApi.list({ entity_type: entityType || undefined, entity_id: entityId || undefined, limit: 200 }); setRows(result.items); setError(null); }
    catch (err) { setError(normalizeError(err)); }
  }, [entityType, entityId]);
  useEffect(() => { void load(); }, [load]);
  const columns: ColumnsType<AuditLogRow> = [
    { title: "时间", dataIndex: "occurred_at" },
    { title: "操作人", dataIndex: "actor" },
    { title: "动作", dataIndex: "action" },
    { title: "对象类型", dataIndex: "entity_type" },
    { title: "对象编号", dataIndex: "entity_id" },
    { title: "原因", dataIndex: "reason", render: (v: string | null) => v || "-" },
  ];
  return <section className="ui-stack"><ErrorBanner error={error} onRetry={() => void load()} /><Card className="glass" title="审计记录"><div className="ui-filter-bar"><Select allowClear placeholder="对象类型" value={entityType || undefined} onChange={(value) => setEntityType(value ?? "")} options={["order", "account", "customer", "lead", "cashflow", "reconciliation"].map((value) => ({ value, label: value }))} /><Input placeholder="对象编号" value={entityId} onChange={(event) => setEntityId(event.target.value)} onPressEnter={() => void load()} /></div><DataTable<AuditLogRow> columns={columns} rows={rows} page={1} pageSize={20} total={rows.length} emptyText="暂无审计记录" onPageChange={() => undefined} /></Card></section>;
}
