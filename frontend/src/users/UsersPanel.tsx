import { Card, Form, Input, Modal, Select, Space, message } from "antd";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../shared/api/client";
import { poolsApi, type Pool } from "../shared/api/catalog";
import { DataTable, PermissionButton } from "../shared/ui";
import { OWNER_SCOPE_LABEL, USER_ROLE_LABEL } from "../shared/lib/labels";

type User = { id: number; username: string; display_name: string; role: string; owner_scope: string; pool_ids: number[]; team_ids: number[]; is_active: boolean; must_change_password: boolean };
type Team = { id: number; code: string; name: string; is_active: boolean };
const roles = [{ value: "ADMIN", label: "系统管理员" }, { value: "OPERATOR", label: "业务经办人" }, { value: "FINANCE", label: "财务" }, { value: "AUDITOR", label: "审核人" }, { value: "VIEWER", label: "查看人" }];
const scopes = [{ value: "SELF", label: "本人" }, { value: "TEAM", label: "团队" }, { value: "ALL", label: "全部" }];

export function UsersPanel() {
  const [rows, setRows] = useState<User[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [resetForm] = Form.useForm();
  const [editing, setEditing] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const load = async () => { try { const [users, teamList, poolList] = await Promise.all([api.get<User[]>("/users"), api.get<Team[]>("/teams"), poolsApi.list()]); setRows(users.data); setTeams(teamList.data); setPools(poolList); } catch (err) { message.error(errorMessage(err)); } };
  useEffect(() => { void load(); }, []);
  const submit = async (values: Record<string, string>) => { try { await api.post("/users", values); message.success("用户已创建"); form.resetFields(); await load(); } catch (err) { message.error(errorMessage(err)); } };
  const updateUser = async (values: Record<string, string>) => {
    if (!editing) return;
    try { await api.patch(`/users/${editing.id}`, values); message.success("用户信息已更新"); setEditing(null); await load(); }
    catch (err) { message.error(errorMessage(err)); }
  };
  const toggleUser = async (user: User) => {
    try { await api.patch(`/users/${user.id}`, { is_active: !user.is_active }); message.success(user.is_active ? "用户已停用" : "用户已启用"); await load(); }
    catch (err) { message.error(errorMessage(err)); }
  };
  const resetPassword = async (values: { password: string }) => {
    if (!resetting) return;
    try { await api.post(`/users/${resetting.id}/reset-password`, { password: values.password }); message.success("密码已重置，下次登录需修改"); setResetting(null); resetForm.resetFields(); }
    catch (err) { message.error(errorMessage(err)); }
  };
  return <Card className="glass" title="用户管理">
    <DataTable<User>
      className="ui-admin-table"
      rows={rows}
      page={1}
      pageSize={20}
      total={rows.length}
      onPageChange={() => undefined}
      emptyText="暂无用户"
      columns={[
        { title: "用户名", dataIndex: "username" },
        { title: "姓名", dataIndex: "display_name" },
        { title: "角色", dataIndex: "role", render: (v: string) => USER_ROLE_LABEL[v] ?? v },
        { title: "数据范围", dataIndex: "owner_scope", render: (v: string) => OWNER_SCOPE_LABEL[v] ?? v },
        { title: "团队", render: (_: unknown, user: User) => (user.team_ids ?? []).map((id) => teams.find((team) => team.id === id)?.name ?? id).join("、") || "-" },
        { title: "资金池", render: (_: unknown, user: User) => (user.pool_ids ?? []).map((id) => pools.find((pool) => pool.id === id)?.name ?? id).join("、") || (user.owner_scope === "ALL" ? "全部" : "-") },
        { title: "状态", dataIndex: "is_active", render: (v: boolean) => v ? "启用" : "停用" },
        { title: "操作", key: "actions", render: (_: unknown, user: User) => <Space><PermissionButton permission="user.manage" size="small" onClick={() => { setEditing(user); editForm.setFieldsValue({ display_name: user.display_name, role: user.role, owner_scope: user.owner_scope, pool_ids: user.pool_ids ?? [], team_ids: user.team_ids ?? [] }); }}>编辑</PermissionButton><PermissionButton permission="user.manage" size="small" onClick={() => toggleUser(user)}>{user.is_active ? "停用" : "启用"}</PermissionButton><PermissionButton permission="user.manage" size="small" onClick={() => setResetting(user)}>重置密码</PermissionButton></Space> },
      ]}
    />
    <Form form={form} layout="inline" onFinish={submit} className="ui-form-spaced">
      <Form.Item name="username" rules={[{ required: true }]}><Input placeholder="用户名" /></Form.Item>
      <Form.Item name="display_name" rules={[{ required: true }]}><Input placeholder="姓名" /></Form.Item>
      <Form.Item name="password" rules={[{ required: true, min: 8 }]}><Input.Password placeholder="初始密码（至少 8 位）" /></Form.Item>
      <Form.Item name="role" initialValue="VIEWER"><Select options={roles} className="ui-control-width-140" /></Form.Item>
      <Form.Item name="owner_scope" initialValue="SELF"><Select options={[{ value: "SELF", label: "本人" }, { value: "TEAM", label: "团队" }, { value: "ALL", label: "全部" }]} className="ui-control-width-100" /></Form.Item>
      <Form.Item name="team_ids"><Select mode="multiple" options={teams.filter((team) => team.is_active).map((team) => ({ value: team.id, label: team.name }))} placeholder="所属团队" className="ui-control-min-180" /></Form.Item>
      <Form.Item name="pool_ids"><Select mode="multiple" options={pools.filter((pool) => pool.status === "ACTIVE").map((pool) => ({ value: pool.id, label: pool.name }))} placeholder="可见资金池" className="ui-control-min-180" /></Form.Item>
      <PermissionButton permission="user.manage" type="primary" htmlType="submit">新增用户</PermissionButton>
    </Form>
    <Modal title={`编辑用户：${editing?.username ?? ""}`} open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={() => editForm.submit()} destroyOnHidden>
      <Form form={editForm} layout="vertical" onFinish={updateUser}>
        <Form.Item name="display_name" label="姓名" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="role" label="角色" rules={[{ required: true }]}><Select options={roles} /></Form.Item>
        <Form.Item name="owner_scope" label="数据范围" rules={[{ required: true }]}><Select options={scopes} /></Form.Item>
        <Form.Item name="team_ids" label="所属团队"><Select mode="multiple" options={teams.filter((team) => team.is_active).map((team) => ({ value: team.id, label: team.name }))} /></Form.Item>
        <Form.Item name="pool_ids" label="可见资金池"><Select mode="multiple" options={pools.filter((pool) => pool.status === "ACTIVE").map((pool) => ({ value: pool.id, label: pool.name }))} /></Form.Item>
      </Form>
    </Modal>
    <Modal title={`重置密码：${resetting?.username ?? ""}`} open={Boolean(resetting)} onCancel={() => setResetting(null)} onOk={() => resetForm.submit()} destroyOnHidden>
      <Form form={resetForm} layout="vertical" onFinish={resetPassword}>
        <Form.Item name="password" label="新密码" rules={[{ required: true, min: 8, message: "密码至少 8 位" }]}><Input.Password placeholder="新密码（至少 8 位）" autoComplete="new-password" /></Form.Item>
      </Form>
    </Modal>
  </Card>;
}
