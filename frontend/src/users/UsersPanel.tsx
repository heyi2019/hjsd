import { appMessage } from "../shared/ui/appFeedback";
import { Card, Form, Input, Space, Typography } from "antd";
import { useCallback, useState } from "react";
import { errorMessage } from "../shared/api/client";
import { teamsApi, usersApi } from "../shared/api/org.api";
import { poolsApi } from "../shared/api/pools.api";
import type { Pool } from "../shared/api/types/finance";
import type { ManagedUser, Team } from "../shared/api/types/org";
import { useSettingsResource } from "../shared/state/useSettingsResource";
import { BusinessActionModal, BusinessRegistrationForm, ConfirmButton, DataTable, ErrorBanner, PermissionButton, Select } from "../shared/ui";
import { OWNER_SCOPE_LABEL, USER_ROLE_LABEL } from "../shared/lib/labels";
import { useOptionSet } from "../shared/lib/optionSets";
import { useSession } from "../shared/state/session";

type User = ManagedUser;

// 角色/数据范围词典不可用时回落的只读集合：保证默认 VIEWER / SELF 始终是带名称的 selected option，
// 避免出现"控件外游离文本"。来源与对应 *_LABEL 一致。
const USER_ROLE_FALLBACK = Object.entries(USER_ROLE_LABEL).map(([value, label]) => ({ value, label }));
const OWNER_SCOPE_FALLBACK = Object.entries(OWNER_SCOPE_LABEL).map(([value, label]) => ({ value, label }));

/** 手机号是手机号验证码 / 微信扫码登录的准入依据（后端按同一正则归一化+校验）。
 *  留空合法（= 不启用免密登录），非空必须是 11 位大陆手机号——避免「配进去了但登录
 *  说未开通」这种只能靠翻库排查的问题。 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const PHONE_RULES = [
  {
    validator: (_: unknown, value?: string) => {
      const text = (value ?? "").trim();
      if (!text) return Promise.resolve();
      return PHONE_PATTERN.test(text)
        ? Promise.resolve()
        : Promise.reject(new Error("请输入正确的 11 位手机号"));
    },
  },
];

// 三个表单必须各自 name：antd 只有在 <Form name> 存在时才给控件 id 加前缀，
// 否则本页的 phone / password 在「新增」「编辑」「重置密码」之间会重复成同一个 DOM id，
// 导致 <label for> 绑定到错误的输入框（点标签聚焦错位、读屏播报错乱）。
export function UsersPanel() {
  const { role } = useSession();
  const roleOptions = useOptionSet("USER_ROLE") ?? USER_ROLE_FALLBACK;
  const scopeOptions = useOptionSet("OWNER_SCOPE") ?? OWNER_SCOPE_FALLBACK;
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [resetForm] = Form.useForm();
  const [editing, setEditing] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const load = useCallback(async () => {
    const [rows, teams, pools] = await Promise.all([usersApi.list(), teamsApi.list(), poolsApi.list()]);
    return { rows, teams, pools };
  }, []);
  const handleLoadError = useCallback((cause: { message: string }) => {
    appMessage.error(cause.message);
  }, []);
  const { data: loaded, error: loadError, reload } = useSettingsResource(load, { onError: handleLoadError });
  const rows = loaded?.rows ?? [];
  const teams = loaded?.teams ?? [];
  const pools = loaded?.pools ?? [];
  const submit = async (values: Record<string, string>) => { try { await usersApi.create(values); appMessage.success("用户已创建"); form.resetFields(); await reload(); } catch (err) { appMessage.error(errorMessage(err)); } };
  const updateUser = async (values: Record<string, string>) => {
    if (!editing) return;
    try { await usersApi.update(editing.id, values); appMessage.success("用户信息已更新"); setEditing(null); await reload(); }
    catch (err) { appMessage.error(errorMessage(err)); }
  };
  const toggleUser = async (user: User) => {
    try { await usersApi.update(user.id, { is_active: !user.is_active }); appMessage.success(user.is_active ? "用户已停用" : "用户已启用"); await reload(); }
    catch (err) { appMessage.error(errorMessage(err)); }
  };
  const resetPassword = async (values: { password: string }) => {
    if (!resetting) return;
    try { await usersApi.resetPassword(resetting.id, values.password); appMessage.success("密码已重置，下次登录需修改"); setResetting(null); resetForm.resetFields(); }
    catch (err) { appMessage.error(errorMessage(err)); }
  };
  return <Card className="glass" title="用户管理">
    <ErrorBanner error={loadError} onRetry={() => void reload()} />
    {import.meta.env.DEV ? (
      <Typography.Paragraph type="secondary">
        开发态当前角色：{role}；开发态角色不纳入服务端人员列表，下面仅展示可由后端管理的用户账号。
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
        { title: "手机号", dataIndex: "phone", render: (v?: string) => v || "-" },
        { title: "角色", dataIndex: "role", render: (v: string) => USER_ROLE_LABEL[v] ?? v },
        { title: "数据范围", dataIndex: "owner_scope", render: (v: string) => OWNER_SCOPE_LABEL[v] ?? v },
        { title: "团队", render: (_: unknown, user: User) => (user.team_ids ?? []).map((id) => teams.find((team) => team.id === id)?.name ?? id).join("、") || "-" },
        { title: "资金账户", render: (_: unknown, user: User) => (user.pool_ids ?? []).map((id) => pools.find((pool) => pool.id === id)?.name ?? id).join("、") || (user.owner_scope === "ALL" ? "全部" : "-") },
        { title: "状态", dataIndex: "is_active", render: (v: boolean) => v ? "启用" : "停用" },
        { title: "操作", key: "actions", render: (_: unknown, user: User) => <Space size={2}><PermissionButton permission="user.manage" size="small" onClick={() => { setEditing(user); editForm.setFieldsValue({ display_name: user.display_name, phone: user.phone ?? "", role: user.role, owner_scope: user.owner_scope, pool_ids: user.pool_ids ?? [], team_ids: user.team_ids ?? [] }); }}>编辑</PermissionButton><ConfirmButton
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
    <BusinessRegistrationForm name="createUser" form={form} layout="inline" onFinish={submit}>
      <Form.Item name="username" rules={[{ required: true }]}><Input placeholder="用户名" /></Form.Item>
      <Form.Item name="display_name" rules={[{ required: true }]}><Input placeholder="姓名" /></Form.Item>
      <Form.Item name="phone" rules={PHONE_RULES}><Input placeholder="手机号（用于免密登录）" autoComplete="tel" /></Form.Item>
      <Form.Item name="password" rules={[{ required: true, min: 8 }]}><Input.Password placeholder="初始密码（至少 8 位）" /></Form.Item>
      <Form.Item name="role" initialValue="VIEWER"><Select options={roleOptions} aria-label="角色" className="ui-control-width-140" /></Form.Item>
      <Form.Item name="owner_scope" initialValue="SELF"><Select options={scopeOptions} aria-label="数据范围" className="ui-control-width-100" /></Form.Item>
      <Form.Item name="team_ids"><Select mode="multiple" aria-label="所属团队" options={teams.filter((team) => team.is_active).map((team) => ({ value: team.id, label: team.name }))} placeholder="所属团队" className="ui-control-min-180" /></Form.Item>
      <Form.Item name="pool_ids"><Select mode="multiple" aria-label="可见资金账户" options={pools.filter((pool) => pool.status === "ACTIVE").map((pool) => ({ value: pool.id, label: pool.name }))} placeholder="可见资金账户" className="ui-control-min-180" /></Form.Item>
      <PermissionButton permission="user.manage" type="primary" htmlType="submit" disabled={Boolean(loadError)}>新增用户</PermissionButton>
    </BusinessRegistrationForm>
    <BusinessActionModal title={`编辑用户：${editing?.username ?? ""}`} fieldCount={6} open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={() => editForm.submit()} destroyOnHidden>
      <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} name="editUser" form={editForm} onFinish={updateUser}>
        <Form.Item name="display_name" label="姓名" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="phone" label="手机号" rules={PHONE_RULES} extra="留空表示不启用免密登录">
          <Input placeholder="11 位手机号" autoComplete="tel" />
        </Form.Item>
        <Form.Item name="role" label="角色" rules={[{ required: true }]}><Select options={roleOptions} aria-label="角色" /></Form.Item>
        <Form.Item name="owner_scope" label="数据范围" rules={[{ required: true }]}><Select options={scopeOptions} aria-label="数据范围" /></Form.Item>
        <Form.Item name="team_ids" label="所属团队"><Select mode="multiple" aria-label="所属团队" options={teams.filter((team) => team.is_active).map((team) => ({ value: team.id, label: team.name }))} /></Form.Item>
        <Form.Item name="pool_ids" label="可见资金账户"><Select mode="multiple" aria-label="可见资金账户" options={pools.filter((pool) => pool.status === "ACTIVE").map((pool) => ({ value: pool.id, label: pool.name }))} /></Form.Item>
      </BusinessRegistrationForm>
    </BusinessActionModal>
    <BusinessActionModal size="compact" title={`重置密码：${resetting?.username ?? ""}`} open={Boolean(resetting)} onCancel={() => setResetting(null)} onOk={() => resetForm.submit()} destroyOnHidden>
      <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} name="resetUser" form={resetForm} onFinish={resetPassword}>
        <Form.Item name="password" label="新密码" rules={[{ required: true, min: 8, message: "密码至少 8 位" }]}><Input.Password placeholder="新密码（至少 8 位）" autoComplete="new-password" /></Form.Item>
      </BusinessRegistrationForm>
    </BusinessActionModal>
  </Card>;
}
