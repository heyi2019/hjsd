import { Card, Checkbox, Form, Input, InputNumber, Table, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { gameTypesApi, type GameTypeOption } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { ErrorBanner, PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";

export function GameTypeSettingsPanel() {
  const [rows, setRows] = useState<GameTypeOption[]>([]);
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

  const submit = async (values: { game_type_name: string; sort_order?: number }) => {
    try {
      await gameTypesApi.create({ name: values.game_type_name, sort_order: Number(values.sort_order ?? 0) });
      message.success("游戏类型已新增");
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
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
          <PermissionButton
            permission="order-type.manage"
            size="small"
            disabled={row.is_default}
            onClick={() => void run(() => gameTypesApi.setActive(row.id, !row.is_active))}
          >
            {row.is_active ? "停用" : "启用"}
          </PermissionButton>
        </PermissionGate>
      ),
    },
  ];

  return (
    <Card className="glass" title="游戏类型">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Typography.Paragraph type="secondary">
        新建订单和账号时使用这里的标准选项，支持模糊搜索；勾选默认后，新建表单会自动带出该类型。默认项不能停用。
      </Typography.Paragraph>
      <Table<GameTypeOption>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: "暂无游戏类型" }}
      />
      <PermissionGate permission="order-type.manage">
        <Form form={form} layout="inline" onFinish={submit} className="ui-form-spaced" initialValues={{ sort_order: 0 }}>
          <Form.Item name="game_type_name" label="游戏类型" rules={[{ required: true, message: "请输入游戏类型" }]}>
            <Input name="game_type_name" autoComplete="off" placeholder="如：王者荣耀" />
          </Form.Item>
          <Form.Item name="sort_order" label="排序">
            <InputNumber min={0} />
          </Form.Item>
          <Form.Item>
            <PermissionButton permission="order-type.manage" type="primary" htmlType="submit">新增游戏类型</PermissionButton>
          </Form.Item>
        </Form>
      </PermissionGate>
    </Card>
  );
}
