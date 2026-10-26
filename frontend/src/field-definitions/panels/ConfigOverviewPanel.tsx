/** 设置页「配置总览」面板：一屏看清这台系统「一共能配什么」+「各自被改了多少次、谁改的、什么时候改的」。
 *
 * 数据来源全部走既有端点，不含任何后端改动：
 * - 条目数：各资源自身的 list 接口；
 * - 累计改动次数 / 最近改动：audit-logs（按 SEttingsItemMeta.entityTypes 逐类查 1 条取 total）；
 * - 表单字段逐作用域明细：按需展开时才并发拉取（33 个作用域），默认不发请求。
 *
 * 所有请求都用 allSettled 容错：某一项无权限或后端报错，只让该项降级显示「—」，不影响整页。
 */
import { Alert, Button, Card, Col, Empty, Row, Space, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { auditApi, orderFormFieldsApi, type AuditEntityStat, type AuditLogRow } from "../../shared/api/catalog";
import { useSession } from "../../shared/state/session";
import { StatusTag } from "../../shared/ui";
import {
  CONFIG_ENTITY_TYPES,
  CONFIG_GROUP_LABEL,
  ENTITY_TYPE_TO_ITEM,
  SETTINGS_ITEMS,
  type ConfigGroupCode,
  type SettingsItemMeta,
} from "../configCatalog";
import { FORM_SCOPE_GROUP_LABEL, FORM_SCOPES } from "../formScopes";

interface ItemStat {
  count: number | null;
  changes: number;
  lastAt: string | null;
  lastActor: string | null;
}

interface ScopeStat {
  total: number;
  disabled: number;
  required: number;
  custom: number;
}

const EMPTY_STAT: ItemStat = { count: null, changes: 0, lastAt: null, lastActor: null };

function formatAt(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

export interface ConfigOverviewPanelProps {
  /** 跳转到设置页某个 Tab；scope 用于表单字段直达具体作用域。 */
  onNavigate: (key: string, params?: { scope?: string }) => void;
}

export function ConfigOverviewPanel({ onNavigate }: ConfigOverviewPanelProps) {
  const { can } = useSession();
  const [stats, setStats] = useState<Record<string, ItemStat>>({});
  const [recent, setRecent] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeStats, setScopeStats] = useState<Record<string, ScopeStat> | null>(null);

  const visibleItems = useMemo(
    () => SETTINGS_ITEMS.filter((item) => !item.permission || can(item.permission)),
    [can],
  );

  useEffect(() => {
    let alive = true;
    const load = async () => {
      // 一次取回全部所需 entity_type 的聚合结果，避免逐类发请求。
      // 用 stats 而非 list：list 的 total 是当前页行数，limit=1 时恒等于 1，不是累计数。
      const wantedTypes = [...new Set(visibleItems.flatMap((item) => item.entityTypes))];
      const [statsRes, flowRes] = await Promise.allSettled([
        wantedTypes.length ? auditApi.stats(wantedTypes) : Promise.resolve([]),
        auditApi.list({ limit: 200 }),
      ]);
      if (!alive) return;

      const byType = new Map<string, AuditEntityStat>();
      if (statsRes.status === "fulfilled") {
        for (const row of statsRes.value) byType.set(row.entity_type, row);
      }

      const next: Record<string, ItemStat> = {};
      await Promise.all(
        visibleItems.map(async (item) => {
          const [countRes] = await Promise.allSettled([item.count()]);
          if (!alive) return;
          const stat: ItemStat = { ...EMPTY_STAT };
          if (countRes.status === "fulfilled") stat.count = countRes.value;
          for (const type of item.entityTypes) {
            const row = byType.get(type);
            if (!row) continue;
            stat.changes += row.count;
            const at = row.last_at ?? null;
            if (at && (!stat.lastAt || at > stat.lastAt)) {
              stat.lastAt = at;
              stat.lastActor = row.last_actor ?? null;
            }
          }
          next[item.key] = stat;
        }),
      );
      if (!alive) return;
      setStats(next);
      setRecent(
        flowRes.status === "fulfilled"
          ? flowRes.value.items
              .filter((row) => row.entity_type && CONFIG_ENTITY_TYPES.includes(row.entity_type))
              .slice(0, 20)
          : [],
      );
      setLoading(false);
    };
    load().catch((err: unknown) => {
      if (!alive) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadScopes = async () => {
    if (scopeStats) return;
    setScopeLoading(true);
    const settled = await Promise.allSettled(
      FORM_SCOPES.map((scope) => orderFormFieldsApi.list(scope.code)),
    );
    const next: Record<string, ScopeStat> = {};
    FORM_SCOPES.forEach((scope, index) => {
      const res = settled[index];
      const fields = res.status === "fulfilled" ? res.value : [];
      next[scope.code] = {
        total: fields.length,
        disabled: fields.filter((f) => !f.is_active).length,
        required: fields.filter((f) => f.required).length,
        custom: fields.filter((f) => f.is_custom).length,
      };
    });
    setScopeStats(next);
    setScopeLoading(false);
  };

  const totals = useMemo(() => {
    const writable = visibleItems.filter((item) => !item.readOnly).length;
    const changes = visibleItems.reduce((sum, item) => sum + (stats[item.key]?.changes ?? 0), 0);
    return {
      total: visibleItems.length,
      writable,
      readOnly: visibleItems.length - writable,
      changes,
    };
  }, [visibleItems, stats]);

  const grouped = useMemo(() => {
    const map = new Map<ConfigGroupCode, SettingsItemMeta[]>();
    for (const item of visibleItems) {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    }
    return [...map.entries()];
  }, [visibleItems]);

  return (
    <div className="ui-stack">
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        本页汇总这台系统所有可配置项。卡片上的「改动」取自审计流水，只统计真实发生过的写操作；
        点「去配置」直达对应页面。
      </Typography.Paragraph>

      <Row gutter={12}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="可见配置项" value={totals.total} loading={loading} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="其中可写" value={totals.writable} loading={loading} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="只读项" value={totals.readOnly} loading={loading} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="累计配置改动" value={totals.changes} loading={loading} />
          </Card>
        </Col>
      </Row>

      {error ? <Alert type="error" showIcon message="配置总览加载失败" description={error} /> : null}

      {grouped.map(([group, list]) => (
        <div key={group} className="ui-stack">
          <Typography.Text strong>{CONFIG_GROUP_LABEL[group]}</Typography.Text>
          <Row gutter={[12, 12]}>
            {list.map((item) => {
              const stat = stats[item.key] ?? EMPTY_STAT;
              return (
                <Col key={item.key} xs={24} md={12} xl={8}>
                  <Card
                    size="small"
                    title={
                      <Space size={6}>
                        <span>{item.label}</span>
                        {item.readOnly ? <Tag color="default">只读</Tag> : null}
                        {!item.readOnly && item.entityTypes.length === 0 ? (
                          <Tooltip title="该项不入审计表（本地偏好或后端未记录），因此无法统计改动">
                            <Tag color="default">不留痕</Tag>
                          </Tooltip>
                        ) : null}
                      </Space>
                    }
                    extra={
                      <Button
                        type="link"
                        size="small"
                        onClick={() => onNavigate(item.key)}
                      >
                        {item.readOnly ? "查看" : "去配置"}
                      </Button>
                    }
                  >
                    <Typography.Paragraph type="secondary" style={{ minHeight: 44, marginBottom: 8 }}>
                      {item.summary}
                    </Typography.Paragraph>
                    <Row gutter={8}>
                      <Col span={8}>
                        <Statistic title="条目" value={stat.count ?? "—"} loading={loading} />
                      </Col>
                      <Col span={8}>
                        <Statistic title="改动" value={stat.changes} loading={loading} />
                      </Col>
                      <Col span={8}>
                        <Statistic
                          title="最近改动"
                          value={stat.lastAt ? formatAt(stat.lastAt) : "—"}
                          loading={loading}
                        />
                      </Col>
                    </Row>
                    {stat.lastActor ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        最近由 {stat.lastActor} 修改
                      </Typography.Text>
                    ) : null}
                  </Card>
                </Col>
              );
            })}
          </Row>
        </div>
      ))}

      <Card
        size="small"
        title="表单字段 · 逐表单明细"
        extra={
          <Button size="small" onClick={loadScopes} loading={scopeLoading}>
            {scopeStats ? "已加载" : "加载明细"}
          </Button>
        }
      >
        {!scopeStats ? (
          <Typography.Text type="secondary">
            共 {FORM_SCOPES.length} 个表单；点「加载明细」查看每个表单的字段数、停用数、必填数与自定义字段数。
          </Typography.Text>
        ) : (
          <Table
            size="small"
            rowKey="code"
            pagination={false}
            scroll={{ y: 360 }}
            dataSource={FORM_SCOPES.map((scope) => ({
              code: scope.code,
              label: scope.label,
              group: FORM_SCOPE_GROUP_LABEL[scope.group] ?? scope.group,
              ...(scopeStats[scope.code] ?? { total: 0, disabled: 0, required: 0, custom: 0 }),
            }))}
            onRow={(row) => ({
              style: { cursor: "pointer" },
              onClick: () => onNavigate("form-fields", { scope: row.code }),
            })}
            columns={[
              { title: "表单", dataIndex: "label", width: 170 },
              { title: "模块", dataIndex: "group", width: 90 },
              { title: "字段数", dataIndex: "total", width: 80, align: "right" as const },
              { title: "必填", dataIndex: "required", width: 70, align: "right" as const },
              {
                title: "停用",
                dataIndex: "disabled",
                width: 80,
                align: "right" as const,
                render: (value: number) =>
                  value > 0 ? <StatusTag status="DISABLED" label={String(value)} /> : value,
              },
              {
                title: "自定义",
                dataIndex: "custom",
                width: 80,
                align: "right" as const,
                render: (value: number) => (value > 0 ? <Tag color="blue">{value}</Tag> : value),
              },
            ]}
          />
        )}
      </Card>

      <Card size="small" title="最近配置改动">
        {recent.length === 0 ? (
          <Empty description={loading ? "加载中…" : "暂无配置类改动记录"} />
        ) : (
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={recent}
            columns={[
              {
                title: "时间",
                dataIndex: "occurred_at",
                width: 150,
                render: (value: string | null) => formatAt(value),
              },
              { title: "操作人", dataIndex: "actor", width: 110 },
              {
                title: "配置域",
                dataIndex: "entity_type",
                width: 130,
                render: (value: string | null) =>
                  ENTITY_TYPE_TO_ITEM[value ?? ""] ?? value ?? "—",
              },
              { title: "动作", dataIndex: "action", width: 110 },
              { title: "对象", dataIndex: "entity_id", width: 90 },
              { title: "备注", dataIndex: "reason", ellipsis: true },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
