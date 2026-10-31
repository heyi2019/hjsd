import { appMessage } from "../../shared/ui/appFeedback";
import { Card, Checkbox, Form, Input, InputNumber, Popconfirm, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { gameTypesApi, type GameTypeOption } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { BusinessForm, ConfirmButton, ErrorBanner, PermissionButton, PermissionGate, Select, StatusTag } from "../../shared/ui";
import "./GameTypeSettingsPanel.css";

export function GameTypeSettingsPanel() {
  const [rows, setRows] = useState<GameTypeOption[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    try {
      setRows(await gameTypesApi.list({ include_inactive: true }));
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (values: { game_type_name: string; sort_order?: number; is_default?: boolean; channel_regions?: string[] }) => {
    try {
      const payload = { name: values.game_type_name, sort_order: Number(values.sort_order ?? 0), channel_regions: (values.channel_regions ?? []).map((item) => item.trim()).filter(Boolean) };
      if (editingId === null) {
        // 后端 create 支持 is_default（自动清其他默认项）；update 不支持，编辑态不传。
        await gameTypesApi.create(values.is_default ? { ...payload, is_default: true } : payload);
        appMessage.success("游戏类型已新增");
      } else {
        await gameTypesApi.update(editingId, payload);
        appMessage.success("游戏类型已更新");
      }
      setEditingId(null);
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const startEditing = (row: GameTypeOption) => {
    setEditingId(row.id);
    form.setFieldsValue({ game_type_name: row.name, sort_order: row.sort_order, channel_regions: row.channel_regions ?? [] });
  };

  const cancelEditing = () => {
    setEditingId(null);
    form.resetFields();
  };

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<GameTypeOption> = [
    { title: "游戏类型", dataIndex: "name" },
    { title: "渠道／区服", render: (_value, row) => row.channel_regions?.length ? row.channel_regions.join("、") : "未配置" },
    { title: "排序", dataIndex: "sort_order" },
    {
      title: "默认",
      dataIndex: "is_default",
      render: (_value: boolean, row) => (
        <Checkbox
          checked={row.is_default}
          aria-label={`${row.name}设为默认`}
          disabled={!row.is_active}
          onChange={(event) => void run(() => gameTypesApi.setDefault(row.id, event.target.checked))}
        />
      ),
    },
    {
      title: "状态",
      dataIndex: "is_active",
      render: (value: boolean) => <StatusTag status={value ? "ACTIVE" : "DISABLED"} label={value ? "启用" : "停用"} />,
    },
    {
      title: "操作",
      render: (_value, row) => (
        <PermissionGate permission="order-type.manage">
          <Space size={2}>
            <PermissionButton
              permission="order-type.manage"
              size="small"
              aria-label={`编辑${row.name}`}
              onClick={() => startEditing(row)}
            >
              编辑
            </PermissionButton>
            <ConfirmButton
              permission="order-type.manage"
              size="small"
              disabled={row.is_default}
              title={row.is_active ? `停用游戏类型「${row.name}」` : `启用游戏类型「${row.name}」`}
              description={row.is_active
                ? "停用后新建订单与账号不再带出该类型；已有数据保留。"
                : "启用后新建表单可重新选择该类型。"}
              danger={row.is_active}
              onConfirm={() => run(() => gameTypesApi.setActive(row.id, !row.is_active))}
            >
              {row.is_active ? "停用" : "启用"}
            </ConfirmButton>
            <Popconfirm
              title={`删除游戏类型「${row.name}」？`}
              description="删除后不可恢复；默认游戏类型需先取消默认。"
              onConfirm={() => run(() => gameTypesApi.remove(row.id))}
            >
              <PermissionButton permission="order-type.manage" size="small" danger>删除</PermissionButton>
            </Popconfirm>
          </Space>
        </PermissionGate>
      ),
    },
  ];

  return (
    <Card className="glass" title="游戏与渠道配置">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Typography.Paragraph type="secondary">
        新建订单和账号时使用这里的标准选项，支持模糊搜索；每个游戏类型可配置对应的渠道／区服。勾选默认后，新建表单会自动带出该类型。默认项不能停用。
      </Typography.Paragraph>
      <div className="game-type-settings__container">
        <Typography.Title level={5}>已配置游戏类型</Typography.Title>
        <Table<GameTypeOption>
          rowKey="id"
          columns={columns}
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: "暂无游戏类型" }}
        />
      </div>
      <PermissionGate permission="order-type.manage">
        <div className="game-type-settings__container">
          <Typography.Title level={5}>{editingId === null ? "新增游戏类型" : "编辑游戏类型"}</Typography.Title>
          <BusinessForm form={form} layout="inline" onFinish={submit} initialValues={{ sort_order: 0 }}>
            <Form.Item name="game_type_name" label="游戏类型" rules={[{ required: true, message: "请输入游戏类型" }]}> 
              <Input name="game_type_name" autoComplete="off" placeholder="如：王者荣耀" />
            </Form.Item>
            <Form.Item name="sort_order" label="排序">
              <InputNumber min={0} />
            </Form.Item>
            <Form.Item name="channel_regions" label="渠道／区服">
              <Select
                mode="tags"
                showSearch
                tokenSeparators={[",", "，", "/", "／"]}
                placeholder="输入后回车新增，例如：安卓QQ"
                notFoundContent="回车即可新增"
                className="ui-control-width-260"
              />
            </Form.Item>
            {editingId === null ? (
              <Form.Item name="is_default" valuePropName="checked" label="默认类型">
                <Checkbox>新建表单自动带出（保存后其他类型取消默认）</Checkbox>
              </Form.Item>
            ) : null}
            <Form.Item>
              <PermissionButton permission="order-type.manage" type="primary" htmlType="submit">
                {editingId === null ? "新增游戏类型" : "保存游戏类型"}
              </PermissionButton>
            </Form.Item>
            {editingId !== null && (
              <Form.Item>
                <PermissionButton permission="order-type.manage" onClick={cancelEditing}>取消编辑</PermissionButton>
              </Form.Item>
            )}
          </BusinessForm>
        </div>
      </PermissionGate>
    </Card>
  );
}
