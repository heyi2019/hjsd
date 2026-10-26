import { Card, Descriptions, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { PolicyDefinition, PolicyVersion } from "../shared/api/catalog";
import { DataTable, PermissionButton, StatusTag } from "../shared/ui";

interface PolicyDetailProps {
  definition: PolicyDefinition;
  versions: PolicyVersion[];
  loading: boolean;
  scopeOptions: { value: string; label: string }[];
  canManage: boolean;
  onOpenEditor: () => void;
  onOpenResolve: () => void;
}

/** 经营规则详情（右栏）：规则元信息 + 版本历史 + 操作入口。 */
export function PolicyDetail({
  definition,
  versions,
  loading,
  scopeOptions,
  canManage,
  onOpenEditor,
  onOpenResolve,
}: PolicyDetailProps) {
  const scopeLabel = scopeOptions.find((o) => o.value === definition.scope_type)?.label ?? definition.scope_type;

  const columns: ColumnsType<PolicyVersion> = [
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
            .join(" · ") || "（无参数）"}
        </span>
      ),
    },
    { title: "状态", dataIndex: "status", width: 110, render: (v: string) => <StatusTag status={v} optionSet="POLICY_STATUS" /> },
    { title: "发布人", dataIndex: "approved_by", width: 100 },
  ];

  return (
    <section className="ui-stack">
      <Card className="glass" title={`规则详情 · ${definition.name}`}>
        <Descriptions column={2} size="small" className="policy-detail-desc">
          <Descriptions.Item label="编码">{definition.policy_code}</Descriptions.Item>
          <Descriptions.Item label="适用范围">{scopeLabel}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <StatusTag status={definition.status} optionSet="POLICY_STATUS" />
          </Descriptions.Item>
          {definition.description ? (
            <Descriptions.Item label="说明">{definition.description}</Descriptions.Item>
          ) : null}
        </Descriptions>
        {canManage ? (
          <Space className="ui-filter-bar">
            <PermissionButton permission="policy.manage" onClick={onOpenEditor}>
              设置配置
            </PermissionButton>
            <PermissionButton permission="policy.manage" onClick={onOpenResolve}>
              生效期自查
            </PermissionButton>
          </Space>
        ) : null}
      </Card>

      <Card className="glass" title="版本历史">
        <Typography.Paragraph type="secondary">
          生效期采用左闭右开区间，相邻版本（前版本失效日 = 后版本生效日）不算重叠。
          每次「设置配置」会生成一条新版本并立即发布，生效日之后的新单套用；历史订单按建单时固化的快照计算，不随改版变化。
        </Typography.Paragraph>
        <DataTable<PolicyVersion>
          columns={columns}
          rows={versions}
          loading={loading}
          page={1}
          pageSize={Math.max(versions.length, 10)}
          total={versions.length}
          emptyText="该规则还没有版本"
          onPageChange={() => undefined}
        />
      </Card>
    </section>
  );
}
