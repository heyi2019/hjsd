/** 经营规则配置（T19 / BAS-06-01~02）：定义 → 版本 → 审批 → 生效期。
 *
 * 页面必须持续强调的两条红线：
 * - **已发布版本不可改**，只能新建版本；
 * - **新版本生效期不得与已有版本重叠**。
 */
import { Card, Select, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  policyApi,
  type PolicyDefinition,
  type PolicyVersion,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import {
  DataTable,
  ErrorBanner,
  PageHeader,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";

const SCOPE_OPTIONS = [
  { value: "GLOBAL", label: "全局" },
  { value: "ORDER_TYPE", label: "按业务类型" },
  { value: "USER", label: "按人员" },
  { value: "POOL", label: "按资金池" },
];

export function PolicySettingsPanel() {
  const [definitions, setDefinitions] = useState<PolicyDefinition[]>([]);
  const [definitionId, setDefinitionId] = useState<number | null>(null);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  const current = definitions.find((d) => d.id === definitionId) ?? null;

  const loadDefinitions = useCallback(async () => {
    try {
      const data = await policyApi.list();
      setDefinitions(data.items);
      setDefinitionId((prev) => prev ?? data.items[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void loadDefinitions();
  }, [loadDefinitions]);

  const loadVersions = useCallback(async () => {
    if (definitionId === null) {
      setVersions([]);
      return;
    }
    setLoading(true);
    try {
      const data = await policyApi.versions(definitionId);
      setVersions(data.items);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [definitionId]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActing(true);
      setError(null);
      try {
        await fn();
        await loadDefinitions();
        await loadVersions();
      } catch (err) {
        setError(normalizeError(err));
      } finally {
        setActing(false);
      }
    },
    [loadDefinitions, loadVersions],
  );

  const versionColumns: ColumnsType<PolicyVersion> = [
    { title: "版本", dataIndex: "version", width: 80, render: (v: number) => `v${v}` },
    {
      title: "生效期",
      width: 200,
      render: (_v, row) => (
        <span className="muted">
          {row.effective_from} ~ {row.effective_to ?? "至今"}
        </span>
      ),
    },
    {
      title: "规则参数",
      dataIndex: "config",
      render: (config: Record<string, unknown>) => (
        <span className="muted">
          {Object.entries(config)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(" · ")}
        </span>
      ),
    },
    { title: "状态", dataIndex: "status", width: 110, render: (v: string) => <StatusTag status={v} /> },
    { title: "审批人", dataIndex: "approved_by", width: 100 },
    {
      title: "操作",
      width: 110,
      render: (_v, row) => (
        <PermissionButton
          permission="policy.approve"
          size="small"
          type="primary"
          loading={acting}
          disabled={row.status !== "DRAFT"}
          onClick={() => void act(() => policyApi.approve(row.id, {}))}
        >
          发布
        </PermissionButton>
      ),
    },
  ];

  return (
    <section className="ui-stack">
      <PageHeader
        title="经营规则"
        description="规则按版本与生效期管理；已发布版本不可修改，只能新建版本。"
        actions={
          <Space className="ui-filter-bar">
            <Select
              style={{ width: 240 }}
              placeholder="选择规则"
              value={definitionId ?? undefined}
              options={definitions.map((d) => ({ value: d.id, label: `${d.name}（${d.policy_code}）` }))}
              onChange={setDefinitionId}
            />
            <PermissionButton
              permission="policy.manage"
              type="primary"
              loading={acting}
              onClick={() =>
                current &&
                void act(() =>
                  policyApi.createVersion(current.id, {
                    effective_from: new Date().toISOString().slice(0, 10),
                    config: {},
                  }),
                )
              }
            >
              新建版本
            </PermissionButton>
          </Space>
        }
      />

      <ErrorBanner error={error} />

      <StatRow
        items={[
          { label: "规则总数", kind: "count", amount: String(definitions.length) },
          {
            label: "已发布",
            kind: "count",
            amount: String(versions.filter((v) => v.status === "ACTIVE").length),
          },
          { label: "草稿版本", kind: "count", amount: String(versions.filter((v) => v.status === "DRAFT").length) },
          { label: "当前规则", kind: "count", amount: current ? current.policy_code : "-" },
        ]}
      />

      <Card className="glass" title="规则定义">
        <DataTable<PolicyDefinition>
          columns={[
            { title: "编码", dataIndex: "policy_code", width: 140 },
            { title: "名称", dataIndex: "name" },
            {
              title: "适用范围",
              dataIndex: "scope_type",
              width: 160,
              render: (v: string) => SCOPE_OPTIONS.find((o) => o.value === v)?.label ?? v,
            },
            { title: "范围 ID", dataIndex: "scope_id", width: 100, render: (v?: number | null) => v ?? "-" },
            { title: "状态", dataIndex: "status", width: 110, render: (v: string) => <StatusTag status={v} /> },
          ]}
          rows={definitions}
          page={1}
          pageSize={Math.max(definitions.length, 10)}
          total={definitions.length}
          emptyText="尚未配置经营规则"
          onPageChange={() => undefined}
        />
      </Card>

      {current ? (
        <Card className="glass" title={`版本历史 · ${current.name}`}>
          <Typography.Paragraph type="secondary">
            生效期采用左闭右开区间，相邻版本（前版本失效日 = 后版本生效日）不算重叠。
            发布只影响生效日之后的新建业务，不会回算历史。
          </Typography.Paragraph>
          <DataTable<PolicyVersion>
            columns={versionColumns}
            rows={versions}
            loading={loading}
            page={1}
            pageSize={Math.max(versions.length, 10)}
            total={versions.length}
            emptyText="该规则还没有版本"
            onPageChange={() => undefined}
          />
        </Card>
      ) : null}
    </section>
  );
}

