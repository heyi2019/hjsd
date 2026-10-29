/** 审计查询：按对象、动作、操作人、时间追溯操作记录，数据范围由后端权限控制。 */
import { Card, Input } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { auditApi, type AuditLogRow } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { AUDIT_ACTION_LABEL, ENTITY_TYPE_LABEL } from "../shared/lib/labels";
import { configurableLabel, useOptionSet } from "../shared/lib/optionSets";
import { useListViewColumns } from "../shared/lib/listColumns";

/** 词典未加载时的回落值，与改造前硬编码一致。 */
const ENTITY_TYPE_FALLBACK = Object.entries(ENTITY_TYPE_LABEL).map(([value, label]) => ({ value, label }));
import { DataTable, ErrorBanner, Select } from "../shared/ui";

export function AuditPanel() {
  const entityTypeOptions = useOptionSet("ENTITY_TYPE") ?? ENTITY_TYPE_FALLBACK;
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [actionOptions, setActionOptions] = useState<string[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const result = await auditApi.list({
        entity_type: entityType || undefined,
        entity_id: entityId || undefined,
        action: action || undefined,
        actor: actor || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        limit: 200,
      });
      setRows(result.items);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, [entityType, entityId, action, actor, fromDate, toDate]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    auditApi.actions().then(setActionOptions).catch(() => setActionOptions([]));
  }, []);
  const { arrange: arrangeColumns } = useListViewColumns("AUDIT_LOG");
  const columns: ColumnsType<AuditLogRow> = [
    { title: "时间", dataIndex: "occurred_at" },
    { title: "操作人", dataIndex: "actor" },
    { title: "动作", dataIndex: "action", render: (v: string) => configurableLabel("AUDIT_ACTION", v, AUDIT_ACTION_LABEL) },
    { title: "对象类型", dataIndex: "entity_type", render: (v: string) => configurableLabel("ENTITY_TYPE", v, ENTITY_TYPE_LABEL)},
    { title: "对象编号", dataIndex: "entity_id"},
    { title: "原因", dataIndex: "reason", render: (v: string | null) => v || "-" },
  ];
  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Card className="glass" title="审计记录">
        <div className="ui-filter-bar">
          <Select
            allowClear
            showSearch
            placeholder="对象类型"
            value={entityType || undefined}
            onChange={(value) => setEntityType(value ?? "")}
            options={entityTypeOptions}
          />
          <Input placeholder="对象编号" value={entityId} onChange={(event) => setEntityId(event.target.value)} onPressEnter={() => void load()} />
          <Select
            allowClear
            showSearch
            placeholder="动作"
            value={action || undefined}
            onChange={(value) => setAction(value ?? "")}
            options={actionOptions.map((value) => ({ value, label: configurableLabel("AUDIT_ACTION", value, AUDIT_ACTION_LABEL) }))}
          />
          <Input placeholder="操作人" value={actor} onChange={(event) => setActor(event.target.value)} onPressEnter={() => void load()} />
          <Input aria-label="审计开始日期" placeholder="开始日期" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
          <Input aria-label="审计结束日期" placeholder="结束日期" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </div>
        <DataTable<AuditLogRow> columns={arrangeColumns(columns)} rows={rows} page={1} pageSize={20} total={rows.length} emptyText="暂无审计记录" onPageChange={() => undefined}/>
      </Card>
    </section>
  );
}
