/** 配置改动追溯页：把「谁在什么时候改了哪项配置」做成可筛选的完整流水。
 *
 * 用于回答「上个月谁改过经营规则」这类跨时间范围的配置追溯问题。
 * 「资金池最近一次停用是谁做的」这类回溯问题。本页在设置页内按配置项 / 动作 / 操作人 /
 * 时间四维筛选 audit_logs，并把 entity_type 翻成配置项中文名。
 *
 * 只读：不提供任何写入口，写入一律回各配置项自己的页面。
 */
import { Card, DatePicker, Input, Select, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { auditApi, type AuditLogRow } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { AUDIT_ACTION_LABEL, ENTITY_TYPE_LABEL } from "../../shared/lib/labels";
import { configurableLabel } from "../../shared/lib/optionSets";
import { DataTable, ErrorBanner, StatusTag } from "../../shared/ui";
import { ENTITY_TYPE_TO_ITEM, SETTINGS_ITEMS } from "../configCatalog";

/** 一次最多取回的条数：配置类改动量级有限，前端分页足够，不做服务端翻页。 */
const FETCH_LIMIT = 500;

interface Filters {
  entityType: string;
  action: string;
  actor: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { entityType: "", action: "", actor: "", from: "", to: "" };

function formatAt(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

export function ConfigAuditPanel() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  // 配置项的 entity_type 选项：一个配置项可能对应多个 entity_type（如经营规则有
  // policy_definition / policy_version），这里摊平成「配置项 · 类型」两级，选的是类型值。
  const entityTypeOptions = useMemo(
    () =>
      SETTINGS_ITEMS.flatMap((item) =>
        item.entityTypes.map((type) => ({
          value: type,
          label: `${item.label} · ${ENTITY_TYPE_LABEL[type] ?? type}`,
        })),
      ).sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN")),
    [],
  );

  useEffect(() => {
    void auditApi
      .actions()
      .then((list) => setActions(list))
      .catch(() => setActions([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await auditApi.list({
        entity_type: filters.entityType || undefined,
        action: filters.action || undefined,
        actor: filters.actor || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        limit: FETCH_LIMIT,
      });
      setRows(res.items ?? []);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (next: Partial<Filters>) => setFilters((prev) => ({ ...prev, ...next }));

  const columns: ColumnsType<AuditLogRow> = [
    { title: "时间", dataIndex: "occurred_at", width: 150, render: (v: string | null) => formatAt(v) },
    { title: "操作人", dataIndex: "actor", width: 110, render: (v: string | null) => v ?? "—" },
    {
      title: "配置项",
      className: "ui-col-md-up",
      onCell: () => ({ className: "ui-col-md-up" }),
      dataIndex: "entity_type",
      width: 160,
      render: (v: string | null) => ENTITY_TYPE_TO_ITEM[v ?? ""] ?? v ?? "—",
    },
    {
      title: "对象类型",
      className: "ui-col-md-up",
      onCell: () => ({ className: "ui-col-md-up" }),
      dataIndex: "entity_type",
      width: 110,
      render: (v: string | null) => configurableLabel("ENTITY_TYPE", v, ENTITY_TYPE_LABEL),
    },
    {
      title: "动作",
      dataIndex: "action",
      width: 160,
      render: (v: string | null) => (v ? configurableLabel("AUDIT_ACTION", v, AUDIT_ACTION_LABEL) : "—"),
    },
    { title: "对象", dataIndex: "entity_id", width: 120, render: (v: string | null) => v ?? "—" },
    { title: "备注", dataIndex: "reason", render: (v: string | null) => v || "—", ellipsis: true, className: "ui-col-md-up", onCell: () => ({ className: "ui-col-md-up" }) },
  ];

  return (
    <div className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Card className="glass" title="配置改动追溯">
        <Typography.Paragraph type="secondary">
          只读流水，记录各配置项的新建 / 编辑 / 停用等动作；写入请回各配置项自己的页面。
          当前筛选下共 {rows.length} 条（上限 {FETCH_LIMIT} 条）。
        </Typography.Paragraph>
        <Space className="ui-filter-bar" wrap>
          <Select
            allowClear
            showSearch
            placeholder="配置项"
            className="ui-control-width-200"
            value={filters.entityType || undefined}
            onChange={(value) => patch({ entityType: value ?? "" })}
            options={entityTypeOptions}
          />
          <Select
            allowClear
            showSearch
            placeholder="动作"
            className="ui-control-width-200"
            value={filters.action || undefined}
            onChange={(value) => patch({ action: value ?? "" })}
            options={actions.map((action) => ({
              value: action,
              label: configurableLabel("AUDIT_ACTION", action, AUDIT_ACTION_LABEL),
            }))}
          />
          <Input
            allowClear
            placeholder="操作人"
            className="ui-control-width-140"
            value={filters.actor}
            onChange={(event) => patch({ actor: event.target.value })}
          />
          <DatePicker.RangePicker
            placeholder={["起始日期", "截止日期"]}
            onChange={(range) => {
              const [from, to] = range ?? [];
              patch({
                from: from ? dayjs(from).format("YYYY-MM-DD") : "",
                to: to ? dayjs(to).format("YYYY-MM-DD") : "",
              });
            }}
          />
        </Space>
        <DataTable<AuditLogRow>
          columns={columns}
          rows={rows}
          page={1}
          pageSize={20}
          total={rows.length}
          loading={loading}
          emptyText="当前筛选下没有配置改动记录"
          onPageChange={() => undefined}
       />
      </Card>
      <Card className="glass" size="small" title="说明">
        <Typography.Paragraph type="secondary">
          「配置项」一列把后端 <code>entity_type</code> 翻成设置页的配置项名；同一配置项可能对应多个
          对象类型（例如经营规则含 <code>policy_definition</code> 与 <code>policy_version</code>），
          请按需要选择具体类型。状态列沿用全局映射，未收录的类型显示原始编码，不会被静默吞掉。
        </Typography.Paragraph>
        <StatusTag status="DISABLED" label="只读" />
      </Card>
    </div>
  );
}
