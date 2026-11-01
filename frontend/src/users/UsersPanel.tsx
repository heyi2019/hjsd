import { appMessage } from "../shared/ui/appFeedback";
import { Card, Form, Input, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import { errorMessage, normalizeError, type NormalizedError } from "../shared/api/client";
import { poolsApi, teamsApi, usersApi, type ManagedUser, type Pool, type Team } from "../shared/api/catalog";
import { BusinessActionModal, BusinessRegistrationForm, ConfirmButton, DataTable, ErrorBanner, PermissionButton, Select } from "../shared/ui";
import { OWNER_SCOPE_LABEL, USER_ROLE_LABEL } from "../shared/lib/labels";
import { useOptionSet } from "../shared/lib/optionSets";
import { useSession } from "../shared/state/session";

type User = ManagedUser;

export function UsersPanel() {
  const { user } = useSession();
  const roleOptions = useOptionSet("USER_ROLE") ?? [];
  const scopeOptions = useOptionSet("OWNER_SCOPE") ?? [];
  const [rows, setRows] = useState<User[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [resetForm] = Form.useForm();
  const [editing, setEditing] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [loadError, setLoadError] = useState<NormalizedError | null>(null);
  const load = async () => {
    try {
      const [users, teamList, poolList] = await Promise.all([usersApi.list(), teamsApi.list(), poolsApi.list()]);
      setRows(users);
      setTeams(teamList);
      setPools(poolList);
      setLoadError(null);
    } catch (err) {
      setLoadError(normalizeError(err));
      appMessage.error(errorMessage(err));
    }
  };
  useEffect(() => { void load(); }, []);
  const submit = async (values: Record<string, string>) => { try { await usersApi.create(values); appMessage.success("用户已创建"); form.resetFields(); await load(); } catch (err) { appMessage.error(errorMessage(err)); } };
  const updateUser = async (values: Record<string, string>) => {
    if (!editing) return;
    try { await usersApi.update(editing.id, values); appMessage.success("用户信息已更新"); setEditing(null); await load(); }
    catch (err) { appMessage.error(errorMessage(err)); }
  };
  const toggleUser = async (user: User) => {
    try { await usersApi.update(user.id, { is_active: !user.is_active }); appMessage.success(user.is_active ? "用户已停用" : "用户已启用"); await load(); }
    catch (err) { appMessage.error(errorMessage(err)); }
  };
  const resetPassword = async (values: { password: string }) => {
    if (!resetting) return;
    try { await usersApi.resetPassword(resetting.id, values.password); appMessage.success("密码已重置，下次登录需修改"); setResetting(null); resetForm.resetFields(); }
    catch (err) { appMessage.error(errorMessage(err)); }
  };
  return <Card className="glass" title="用户管理">
    <ErrorBanner error={loadError} onRetry={() => void load()} />
    {import.meta.env.DEV ? (
      <Typography.Paragraph type="secondary">
        开发态当前角色：{user}；开发态角色不纳入服务端人员列表，下面仅展示可由后端管理的用户账号。
      </Typography.Paragraph>
    ) : null}
    <DataTable<User>
      className="ui-admin-table"
      rows={rows}
      page={1}
      pageSize={20}
      total={rows.length}
      onPageChange={() => undefined}
      emptyText={loadError ? "用户数据不可用，请点击重新加载" : "暂无用户"}
      columns={[
        { title: "用户名", dataIndex: "username" },
        { title: "姓名", dataIndex: "display_name" },
        { title: "角色", dataIndex: "role", render: (v: string) => USER_ROLE_LABEL[v] ?? v },
        { title: "数据范围", dataIndex: "owner_scope", render: (v: string) => OWNER_SCOPE_LABEL[v] ?? v },
        { title: "团队", render: (_: unknown, user: User) => (user.team_ids ?? []).map((id) => teams.find((team) => team.id === id)?.name ?? id).join("、") || "-" },
        { title: "资金池", render: (_: unknown, user: User) => (user.pool_ids ?? []).map((id) => pools.find((pool) => pool.id === id)?.name ?? id).join("、") || (user.owner_scope === "ALL" ? "全部" : "-") },
        { title: "状态", dataIndex: "is_active", render: (v: boolean) => v ? "启用" : "停用" },
        { title: "操作", key: "actions", render: (_: unknown, user: User) => <Space size={2}><PermissionButton permission="user.manage" size="small" onClick={() => { setEditing(user); editForm.setFieldsValue({ display_name: user.display_name, role: user.role, owner_scope: user.owner_scope, pool_ids: user.pool_ids ?? [], team_ids: user.team_ids ?? [] }); }}>编辑</PermissionButton><ConfirmButton
              permission="user.manage"
              size="small"
              title={user.is_active ? "停用该用户" : "启用该用户"}
              description={user.is_active
                ? "停用后该用户立即无法登录，其在途业务不受影响。"
                : "启用后该用户可重新登录。"}
              danger={user.is_active}
              onConfirm={() => toggleUser(user)}
            >
              {user.is_active ? "停用" : "启用"}
            </ConfirmButton><PermissionButton permission="user.manage" size="small" onClick={() => setResetting(user)}>重置密码</PermissionButton></Space> },
      ]}
    />
    <BusinessRegistrationForm form={form} layout="inline" onFinish={submit}>
      <Form.Item name="username" rules={[{ required: true }]}><Input placeholder="用户名" /></Form.Item>
      <Form.Item name="display_name" rules={[{ required: true }]}><Input placeholder="姓名" /></Form.Item>
      <Form.Item name="password" rules={[{ required: true, min: 8 }]}><Input.Password placeholder="初始密码（至少 8 位）" /></Form.Item>
      <Form.Item name="role" initialValue="VIEWER"><Select options={roleOptions} className="ui-control-width-140" /></Form.Item>
      <Form.Item name="owner_scope" initialValue="SELF"><Select options={scopeOptions} className="ui-control-width-100" /></Form.Item>
      <Form.Item name="team_ids"><Select mode="multiple" options={teams.filter((team) => team.is_active).map((team) => ({ value: team.id, label: team.name }))} placeholder="所属团队" className="ui-control-min-180" /></Form.Item>
      <Form.Item name="pool_ids"><Select mode="multiple" options={pools.filter((pool) => pool.status === "ACTIVE").map((pool) => ({ value: pool.id, label: pool.name }))} placeholder="可见资金池" className="ui-control-min-180" /></Form.Item>
      <PermissionButton permission="user.manage" type="primary" htmlType="submit" disabled={Boolean(loadError)}>新增用户</PermissionButton>
    </BusinessRegistrationForm>
    <BusinessActionModal title={`编辑用户：${editing?.username ?? ""}`} fieldCount={5} open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={() => editForm.submit()} destroyOnHidden>
      <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} form={editForm} onFinish={updateUser}>
        <Form.Item name="display_name" label="姓名" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="role" label="角色" rules={[{ required: true }]}><Select options={roleOptions} /></Form.Item>
        <Form.Item name="owner_scope" label="数据范围" rules={[{ required: true }]}><Select options={scopeOptions} /></Form.Item>
        <Form.Item name="team_ids" label="所属团队"><Select mode="multiple" options={teams.filter((team) => team.is_active).map((team) => ({ value: team.id, label: team.name }))} /></Form.Item>
        <Form.Item name="pool_ids" label="可见资金池"><Select mode="multiple" options={pools.filter((pool) => pool.status === "ACTIVE").map((pool) => ({ value: pool.id, label: pool.name }))} /></Form.Item>
      </BusinessRegistrationForm>
    </BusinessActionModal>
    <BusinessActionModal size="compact" title={`重置密码：${resetting?.username ?? ""}`} open={Boolean(resetting)} onCancel={() => setResetting(null)} onOk={() => resetForm.submit()} destroyOnHidden>
      <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} form={resetForm} onFinish={resetPassword}>
        <Form.Item name="password" label="新密码" rules={[{ required: true, min: 8, message: "密码至少 8 位" }]}><Input.Password placeholder="新密码（至少 8 位）" autoComplete="new-password" /></Form.Item>
      </BusinessRegistrationForm>
    </BusinessActionModal>
  </Card>;
}
