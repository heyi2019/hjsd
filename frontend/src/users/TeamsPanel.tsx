import { appMessage } from "../shared/ui/appFeedback";
import { Card, Form, Input } from "antd";
import { useEffect, useState } from "react";
import { normalizeError, type NormalizedError } from "../shared/api/client";
import { teamsApi, type Team } from "../shared/api/catalog";
import { BusinessRegistrationForm, ConfirmButton, DataTable, ErrorBanner, PermissionButton } from "../shared/ui";

export function TeamsPanel() {
  const [rows, setRows] = useState<Team[]>([]);
  const [form] = Form.useForm();
  const [error, setError] = useState<NormalizedError | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      setRows(await teamsApi.list());
      setError(null);
    } catch (err) {
      const normalized = normalizeError(err);
      setError(normalized);
      appMessage.error(normalized.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const submit = async (values: Record<string, string>) => {
    const code = String(values.code ?? "").trim();
    const duplicated = rows.some((team) => team.code.trim().toUpperCase() === code.toUpperCase());
    if (duplicated) {
      appMessage.error("团队编码已存在");
      return;
    }
    try {
      await teamsApi.create({ ...values, code });
      appMessage.success("团队已创建");
      form.resetFields();
      await load();
    } catch (err) { appMessage.error(normalizeError(err).message); }
  };
  const toggle = async (team: Team) => { try { await teamsApi.update(team.id, { is_active: !team.is_active }); appMessage.success(team.is_active ? "团队已停用" : "团队已启用"); await load(); } catch (err) { appMessage.error(normalizeError(err).message); } };
  return <Card className="glass" title="团队管理">
    <ErrorBanner error={error} onRetry={() => void load()} retrying={loading} />
    <DataTable<Team>
      className="ui-admin-table"
      rows={rows}
      page={1}
      pageSize={20}
      total={rows.length}
      onPageChange={() => undefined}
      emptyText={error ? "团队数据不可用，请点击重新加载" : "暂无团队"}
      loading={loading}
      columns={[
        { title: "编码", dataIndex: "code" },
        { title: "团队名称", dataIndex: "name" },
        { title: "说明", dataIndex: "description" },
        { title: "状态", dataIndex: "is_active", render: (value: boolean) => value ? "启用" : "停用" },
        { title: "操作", render: (_: unknown, team: Team) => <ConfirmButton
              permission="user.manage"
              size="small"
              title={team.is_active ? "停用该团队" : "启用该团队"}
              description={team.is_active ? "停用后团队成员的数据范围将受影响。" : "启用后恢复该团队的数据范围。"}
              danger={team.is_active}
              onConfirm={() => toggle(team)}
            >
              {team.is_active ? "停用" : "启用"}
            </ConfirmButton> },
      ]}
    />
    <BusinessRegistrationForm form={form} layout="inline" onFinish={submit}>
      <Form.Item name="code" rules={[{ required: true, min: 2 }]}><Input placeholder="团队编码" /></Form.Item>
      <Form.Item name="name" rules={[{ required: true }]}><Input placeholder="团队名称" /></Form.Item>
      <Form.Item name="description"><Input placeholder="说明（可选）" /></Form.Item>
      <PermissionButton permission="user.manage" type="primary" htmlType="submit" disabled={loading || Boolean(error)}>新增团队</PermissionButton>
    </BusinessRegistrationForm>
  </Card>;
}
