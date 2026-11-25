import { appMessage } from "../../shared/ui/appFeedback";
import { Card, Form, Input } from "antd";
import { useCallback, useRef, useState } from "react";
import { normalizeError } from "../../shared/api/client";
import { teamsApi } from "../../shared/api/org.api";
import type { Team } from "../../shared/api/types/org";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { useReferenceRefresh } from "../../shared/hooks/useReferenceRefresh";
import { BusinessRegistrationForm, ConfirmButton, DataTable, ErrorBanner, PermissionButton } from "../../shared/ui";

export function TeamsPanel() {
  const [form] = Form.useForm();
  const load = useCallback(() => teamsApi.list(), []);
  const handleLoadError = useCallback((cause: { message: string }) => {
    appMessage.error(cause.message);
  }, []);
  const { data: loadedRows, loading, error, reload } = useSettingsResource(load, { onError: handleLoadError });
  useReferenceRefresh("teams", reload, true);
  const rows = loadedRows ?? [];
  const createInFlight = useRef(false);
  const [creating, setCreating] = useState(false);
  const submit = async (values: Record<string, string>) => {
    if (createInFlight.current) return;
    createInFlight.current = true;
    setCreating(true);
    try {
      await teamsApi.create(values);
      appMessage.success("团队已创建");
      form.resetFields();
      await reload();
    } catch (err) { appMessage.error(normalizeError(err).message); }
    finally { createInFlight.current = false; setCreating(false); }
  };
  const toggle = async (team: Team) => { try { await teamsApi.update(team.id, { is_active: !team.is_active }); appMessage.success(team.is_active ? "团队已停用" : "团队已启用"); await reload(); } catch (err) { appMessage.error(normalizeError(err).message); } };
  return <Card className="glass" title="团队管理">
    <ErrorBanner error={error} onRetry={() => void reload()} retrying={loading} />
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
      <Form.Item name="name" rules={[{ required: true }]}><Input placeholder="团队名称" /></Form.Item>
      <Form.Item name="description"><Input placeholder="说明（可选）" /></Form.Item>
      <PermissionButton permission="user.manage" type="primary" htmlType="submit" loading={creating} disabled={loading || Boolean(error) || creating}>新增团队</PermissionButton>
    </BusinessRegistrationForm>
  </Card>;
}
