/** 审计查询：按对象、动作、操作人、时间追溯操作记录，数据范围由后端权限控制。 */
import { Card, Input } from "antd";
import dayjs from "dayjs";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { auditApi } from "../shared/api/reports.api";
import type { AuditLogRow } from "../shared/api/types/ops";
import { normalizeError } from "../shared/api/client";
import { AUDIT_ACTION_LABEL, ENTITY_TYPE_LABEL } from "../shared/lib/labels";
import { formatDateTimeMinute } from "../shared/lib/format";
import { configurableLabel } from "../shared/lib/optionSets";
import { useListViewColumns } from "../shared/lib/listColumns";
import { CONFIG_ENTITY_TYPE_LABEL, ENTITY_TYPE_TO_ITEM, SETTINGS_ITEMS } from "../settings/configCatalog";

function entityTypeLabel(value: string): string {
  return CONFIG_ENTITY_TYPE_LABEL[value] ?? ENTITY_TYPE_LABEL[value] ?? ENTITY_TYPE_LABEL[value.toLowerCase()] ?? value;
}

const CONFIG_ITEM_OPTIONS = SETTINGS_ITEMS
  .flatMap((item) => item.entityTypes.map((type) => ({
    value: type,
    label: `${item.label} · ${entityTypeLabel(type)}`,
  })))
  .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));

/** 词典未加载时的回落值，与改造前硬编码一致。 */
const ENTITY_TYPE_FALLBACK = Object.entries(ENTITY_TYPE_LABEL).map(([value, label]) => ({ value, label }));
const ACTION_FALLBACK = Object.entries(AUDIT_ACTION_LABEL).map(([value, label]) => ({ value, label }));
import { DataTable, DateField, ErrorBanner, Select } from "../shared/ui";
import "./AuditPanel.css";

export function AuditPanel() {
  // 对象类型筛选直接用代码事实源（ENTITY_TYPE_LABEL 与审计实际写入的小写表名对齐）：
  // ENTITY_TYPE 词典已被历史数据污染（混入 OrderTypePool/Seed 等类名 28 值），不可作选项源。
  const entityTypeOptions = ENTITY_TYPE_FALLBACK;
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const [configItem, setConfigItem] = useState("");
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [actionOptions, setActionOptions] = useState<string[]>(Object.keys(AUDIT_ACTION_LABEL));
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const result = await auditApi.list({
        entity_type: configItem || entityType || undefined,
        entity_id: entityId || undefined,
        action: action || undefined,
        actor: actor || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      if (request !== requestRef.current) return;
      setRows(result.items);
      setTotal(result.total);
      setError(null);
    } catch (err) {
      if (request === requestRef.current) setError(normalizeError(err));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [configItem, entityType, entityId, action, actor, fromDate, toDate, page, pageSize]);
  useEffect(() => { setPage(1); }, [configItem, entityType, entityId, action, actor, fromDate, toDate]);
  useEffect(() => { void load(); return () => { requestRef.current += 1; }; }, [load]);
  useEffect(() => {
    auditApi.actions().then(setActionOptions).catch(() => undefined);
  }, []);
  const { arrange: arrangeColumns } = useListViewColumns("AUDIT_LOG");
  const columns: ColumnsType<AuditLogRow> = [
    { title: "时间", dataIndex: "occurred_at", render: (v: string | null | undefined) => formatDateTimeMinute(v) },
    { title: "操作人", dataIndex: "actor" },
    { title: "配置项", key: "config_item", render: (_v, row) => ENTITY_TYPE_TO_ITEM[row.entity_type ?? ""] ?? "—" },
    { title: "动作", dataIndex: "action", render: (v: string) => configurableLabel("AUDIT_ACTION", v, AUDIT_ACTION_LABEL) },
    { title: "对象类型", dataIndex: "entity_type", render: (v: string) => {
      // 词典优先 → 配置类型翻译（Pool/GameTypeOption 等类名写点）→ 原值兜底
      const dictLabel = configurableLabel("ENTITY_TYPE", v, ENTITY_TYPE_LABEL);
      if (dictLabel !== v) return dictLabel;
      return CONFIG_ENTITY_TYPE_LABEL[v] ?? v;
    }},
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
            placeholder="配置项"
            className="audit-filter-select audit-config-item-select"
            value={configItem || undefined}
            onChange={(value) => {
              setConfigItem(value ?? "");
              if (value) setEntityType("");
            }}
            options={CONFIG_ITEM_OPTIONS}
          />
          <Select
            allowClear
            showSearch
            placeholder="对象类型"
            className="audit-filter-select audit-entity-type-select"
            value={entityType || undefined}
            onChange={(value) => {
              setEntityType(value ?? "");
              if (value) setConfigItem("");
            }}
            options={entityTypeOptions}
          />
          <Input className="audit-filter-input" placeholder="对象编号" value={entityId} onChange={(event) => setEntityId(event.target.value)} onPressEnter={() => void load()} />
          <Select
            allowClear
            showSearch
            placeholder="动作"
            className="audit-filter-select audit-action-select"
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
        <DataTable<AuditLogRow> columns={arrangeColumns(columns)} rows={rows} loading={loading} page={page} pageSize={pageSize} total={total} controlledPaging emptyText="暂无审计记录" onPageChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}/>
      </Card>
    </section>
  );
}
