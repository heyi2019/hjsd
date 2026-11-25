import { CfgGroup, CfgItem, FieldConfigScope } from "../../shared/forms/ConfigurableField";
import { appMessage } from "../../shared/ui/appFeedback";
import { Checkbox, Form, Input, InputNumber, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useRef, useState } from "react";
import { gameTypesApi } from "../../shared/api/misc.api";
import type { GameTypeOption } from "../../shared/api/types/org";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { useReferenceRefresh } from "../../shared/hooks/useReferenceRefresh";
import { BusinessRegistrationForm, ConfirmButton, DataTable, ErrorBanner, PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";
import "./SettingsSubpanel.css";
import "./GameTypeSettingsPanel.css";

export function GameTypeSettingsPanel() {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [mutationError, setMutationError] = useState<NormalizedError | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(() => gameTypesApi.list({ include_inactive: true }), []);
  const { data: loadedRows, loading, error: loadError, reload } = useSettingsResource(load);
  useReferenceRefresh("gameTypes", reload, true);
  const rows = loadedRows ?? [];
  const error = mutationError ?? loadError;

  const submitInFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (values: { game_type_name: string; sort_order?: number; is_default?: boolean; channel_regions?: Array<{ value?: string; label: string }> }) => {
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setSubmitting(true);
    try {
      const previous = rows.find((row) => row.id === editingId);
      const payload = { name: values.game_type_name, sort_order: Number(values.sort_order ?? previous?.sort_order ?? 0), channel_regions: (values.channel_regions ?? previous?.channel_regions ?? []).map((item) => ({ ...(item.value ? { value: item.value } : {}), label: item.label.trim() })).filter((item) => item.label) };
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
      setMutationError(null);
      await reload();
    } catch (err) {
      setMutationError(normalizeError(err));
    } finally {
      submitInFlight.current = false;
      setSubmitting(false);
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

  const runInFlight = useRef(false);
  const run = async (action: () => Promise<unknown>) => {
    if (runInFlight.current) return;
    runInFlight.current = true;
    try {
      await action();
      setMutationError(null);
      await reload();
    } catch (err) {
      setMutationError(normalizeError(err));
    } finally {
      runInFlight.current = false;
    }
  };

  const columns: ColumnsType<GameTypeOption> = [
    { title: "游戏类型", dataIndex: "name" },
    { title: "渠道／区服", render: (_value, row) => row.channel_regions?.length ? row.channel_regions.map((item) => item.label).join("、") : "未配置" },
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
            <ConfirmButton
              permission="order-type.manage"
              size="small"
              danger
              title={`删除游戏类型「${row.name}」？`}
              description="删除后不可恢复；默认游戏类型需先取消默认。"
              okText="删除"
              onConfirm={async () => {
                await run(() => gameTypesApi.remove(row.id));
              }}
            >
              删除
            </ConfirmButton>
          </Space>
        </PermissionGate>
      ),
    },
  ];

  return (
    <section className="game-type-settings-panel">
      <ErrorBanner error={error} onRetry={() => void reload()} retrying={loading} />
      <Typography.Paragraph type="secondary">
        新建订单和账号时使用这里的标准选项，支持模糊搜索；每个游戏类型可配置对应的渠道／区服。勾选默认后，新建表单会自动带出该类型。默认项不能停用。
      </Typography.Paragraph>
      <div className="settings-subpanel game-type-settings__container">
        <Typography.Title level={5}>已配置游戏类型</Typography.Title>
        <DataTable<GameTypeOption>
          size="small"
          rowKey="id"
          columns={columns}
          rows={rows}
          loading={loading}
          page={1}
          pageSize={10}
          total={rows.length}
          onPageChange={() => undefined}
          pagination={false}
          emptyText="暂无游戏类型"
        />
      </div>
      <PermissionGate permission="order-type.manage">
        <div className="settings-subpanel game-type-settings__container">
          <Typography.Title level={5}>{editingId === null ? "新增游戏类型" : "编辑游戏类型"}</Typography.Title>
          <FieldConfigScope scope="SYSGAME" active={true}><BusinessRegistrationForm form={form} layout="inline" onFinish={submit} initialValues={{ sort_order: 0 }}>
            <CfgItem name="game_type_name" label="游戏类型" rules={[{ required: true, message: "请输入游戏类型" }]}>
              <Input name="game_type_name" autoComplete="off" placeholder="如：王者荣耀" />
            </CfgItem>
            <CfgItem name="sort_order" label="排序">
              <InputNumber min={0} />
            </CfgItem>
            <CfgGroup name="channel_regions" label="渠道／区服">
              <Form.List name="channel_regions">
                {(fields, { add, remove }) => <Space direction="vertical">
                  {fields.map(({ key, name, ...restField }, index) => <Space key={key}>
                    <Form.Item {...restField} name={[name, "value"]} hidden><Input /></Form.Item>
                    <Form.Item {...restField} name={[name, "label"]} noStyle rules={[{ required: true, whitespace: true, message: "请输入渠道名称" }]}>
                      <Input aria-label={`渠道名称 ${index + 1}`} placeholder="例如：安卓QQ" className="ui-control-width-200" />
                    </Form.Item>
                    <PermissionButton permission="order-type.manage" size="small" onClick={() => remove(name)}>删除渠道</PermissionButton>
                  </Space>)}
                  <PermissionButton permission="order-type.manage" size="small" onClick={() => add({ label: "" })}>添加渠道</PermissionButton>
                </Space>}
              </Form.List>
            </CfgGroup>
            {editingId === null ? (
              <CfgItem name="is_default" valuePropName="checked" label="默认类型">
                <Checkbox>新建表单自动带出（保存后其他类型取消默认）</Checkbox>
              </CfgItem>
            ) : null}
            <Form.Item>
              <PermissionButton permission="order-type.manage" type="primary" htmlType="submit" loading={submitting} disabled={submitting}>
                {editingId === null ? "新增游戏类型" : "保存游戏类型"}
              </PermissionButton>
            </Form.Item>
            {editingId !== null && (
              <Form.Item>
                <PermissionButton permission="order-type.manage" onClick={cancelEditing}>取消编辑</PermissionButton>
              </Form.Item>
            )}
          </BusinessRegistrationForm></FieldConfigScope>
        </div>
      </PermissionGate>
    </section>
  );
}
