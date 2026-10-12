import { Card, Form, Input, Table, message } from "antd";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../shared/api/client";
import { PermissionButton } from "../shared/ui";

type Team = { id: number; code: string; name: string; description?: string | null; is_active: boolean };

export function TeamsPanel() {
  const [rows, setRows] = useState<Team[]>([]);
  const [form] = Form.useForm();
  const load = async () => { try { setRows((await api.get<Team[]>("/teams")).data); } catch (err) { message.error(errorMessage(err)); } };
  useEffect(() => { void load(); }, []);
  const submit = async (values: Record<string, string>) => { try { await api.post("/teams", values); message.success("团队已创建"); form.resetFields(); await load(); } catch (err) { message.error(errorMessage(err)); } };
  const toggle = async (team: Team) => { try { await api.patch(`/teams/${team.id}`, { is_active: !team.is_active }); message.success(team.is_active ? "团队已停用" : "团队已启用"); await load(); } catch (err) { message.error(errorMessage(err)); } };
  return <Card className="glass" title="团队管理">
    <Table rowKey="id" dataSource={rows} pagination={false} columns={[{ title: "编码", dataIndex: "code" }, { title: "团队名称", dataIndex: "name" }, { title: "说明", dataIndex: "description" }, { title: "状态", dataIndex: "is_active", render: (value: boolean) => value ? "启用" : "停用" }, { title: "操作", render: (_: unknown, team: Team) => <PermissionButton permission="user.manage" size="small" onClick={() => toggle(team)}>{team.is_active ? "停用" : "启用"}</PermissionButton> }]} />
    <Form form={form} layout="inline" onFinish={submit} style={{ marginTop: 16 }}>
      <Form.Item name="code" rules={[{ required: true, min: 2 }]}><Input placeholder="团队编码" /></Form.Item>
      <Form.Item name="name" rules={[{ required: true }]}><Input placeholder="团队名称" /></Form.Item>
      <Form.Item name="description"><Input placeholder="说明（可选）" /></Form.Item>
      <PermissionButton permission="user.manage" type="primary" htmlType="submit">新增团队</PermissionButton>
    </Form>
  </Card>;
}
