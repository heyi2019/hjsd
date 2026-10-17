import { Card, Form, Input, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { poolsApi, type Pool } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { POOL_OWNERSHIP_LABEL, POOL_TYPE_LABEL } from "../../shared/lib/labels";
import { DataTable, ErrorBanner, PermissionButton, PermissionGate, StatusTag } from "../../shared/ui";

export function PoolsPanel() {
  const [rows, setRows] = useState<Pool[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();
  const load = useCallback(async () => {
    try {
      setRows(await poolsApi.list());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (values: Record<string, unknown>) => {
    try {
      await poolsApi.create({
        code: (values.code as string).toUpperCase(),
        name: values.name as string,
        pool_type: (values.pool_type as string) ?? "OTHER",
        ownership: (values.ownership as string) ?? "OWNED",
      });
      message.success("资金池已创建");
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<Pool> = [
    { title: "代码", dataIndex: "code" },
    { title: "名称", dataIndex: "name" },
    { title: "类型", dataIndex: "pool_type", render: (v: string) => POOL_TYPE_LABEL[v] ?? v },
    { title: "归属", dataIndex: "ownership", render: (v: string) => POOL_OWNERSHIP_LABEL[v] ?? v },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
  ];

  return (
    <Card className="glass" title="资金池主数据">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <DataTable<Pool>
        columns={columns}
        rows={rows}
        page={1}
        pageSize={Math.max(rows.length, 10)}
        total={rows.length}
        emptyText="暂无资金池"
        onPageChange={() => undefined}
      />
      <PermissionGate
        permission="pool.manage"
        fallback={<Typography.Paragraph type="secondary">当前角色无主数据维护权限。</Typography.Paragraph>}
      >
        <Form form={form} layout="inline" onFinish={submit} className="ui-form-spaced">
          <Form.Item name="code" rules={[{ required: true }]}>
            <Input placeholder="池代码，如 HJ_CUSTODY" />
          </Form.Item>
          <Form.Item name="name" rules={[{ required: true }]}>
            <Input placeholder="显示名" />
          </Form.Item>
          <Form.Item>
            <PermissionButton permission="pool.manage" type="primary" htmlType="submit">
              新增资金池
            </PermissionButton>
          </Form.Item>
        </Form>
      </PermissionGate>
    </Card>
  );
}
