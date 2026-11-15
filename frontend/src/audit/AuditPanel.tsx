/** 审计查询：按对象、动作、操作人、时间追溯操作记录，数据范围由后端权限控制。 */
import { Card, Input } from "antd";
import dayjs from "dayjs";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { auditApi } from "../shared/api/reports.api";
import type { AuditLogRow } from "../shared/api/types/ops";
import { normalizeError } from "../shared/api/client";
import { AUDIT_ACTION_LABEL, ENTITY_TYPE_LABEL } from "../shared/lib/labels";
import { formatDateTimeMinute } from "../shared/lib/format";
import { configurableLabel, useOptionSet } from "../shared/lib/optionSets";
import { useListViewColumns } from "../shared/lib/listColumns";

/** 词典未加载时的回落值，与改造前硬编码一致。 */
const ENTITY_TYPE_FALLBACK = Object.entries(ENTITY_TYPE_LABEL).map(([value, label]) => ({ value, label }));
const ACTION_FALLBACK = Object.entries(AUDIT_ACTION_LABEL).map(([value, label]) => ({ value, label }));
import { DataTable, DateField, ErrorBanner, Select } from "../shared/ui";
import "./AuditPanel.css";

export function AuditPanel() {
  const entityTypeOptions = useOptionSet("ENTITY_TYPE") ?? ENTITY_TYPE_FALLBACK;
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [actionOptions, setActionOptions] = useState<string[]>(Object.keys(AUDIT_ACTION_LABEL));
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
    auditApi.actions().then(setActionOptions).catch(() => undefined);
  }, []);
  const { arrange: arrangeColumns } = useListViewColumns("AUDIT_LOG");
  const columns: ColumnsType<AuditLogRow> = [
    { title: "时间", dataIndex: "occurred_at", render: (v: string | null | undefined) => formatDateTimeMinute(v) },
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
        <div className="ui-filter-bar audit-filter-bar">
          <Select
            allowClear
            showSearch
            placeholder="对象类型"
            className="audit-filter-select"
            value={entityType || undefined}
            onChange={(value) => setEntityType(value ?? "")}
            options={entityTypeOptions}
          />
          <Input className="audit-filter-input" placeholder="对象编号" value={entityId} onChange={(event) => setEntityId(event.target.value)} onPressEnter={() => void load()} />
          <Select
            allowClear
            showSearch
            placeholder="动作"
            className="audit-filter-select"
            value={action || undefined}
            onChange={(value) => setAction(value ?? "")}
            options={actionOptions.length > 0
              ? actionOptions.map((value) => ({ value, label: configurableLabel("AUDIT_ACTION", value, AUDIT_ACTION_LABEL) }))
              : ACTION_FALLBACK}
          />
          <Input className="audit-filter-input" placeholder="操作人" value={actor} onChange={(event) => setActor(event.target.value)} onPressEnter={() => void load()} />
          <DateField
            className="audit-filter-date"
            aria-label="审计开始日期"
            placeholder="开始日期"
            value={fromDate ? dayjs(fromDate) : null}
            onChange={(value) => setFromDate(value?.format("YYYY-MM-DD") ?? "")}
          />
          <DateField
            className="audit-filter-date"
            aria-label="审计结束日期"
            placeholder="结束日期"
            value={toDate ? dayjs(toDate) : null}
            onChange={(value) => setToDate(value?.format("YYYY-MM-DD") ?? "")}
          />
        </div>
        <DataTable<AuditLogRow> columns={arrangeColumns(columns)} rows={rows} page={1} pageSize={20} total={rows.length} emptyText="暂无审计记录" onPageChange={() => undefined}/>
      </Card>
    </section>
  );
}
