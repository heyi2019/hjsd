import { Card, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { orderTypesApi, type OrderType } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { CAPITAL_TYPE_LABEL } from "../../shared/lib/labels";
import { DataTable, ErrorBanner, PermissionGate, StatusTag } from "../../shared/ui";

export function OrderTypesPanel() {
  const [rows, setRows] = useState<OrderType[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const load = useCallback(async () => {
    try {
      setRows(await orderTypesApi.list());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<OrderType> = [
    { title: "代码", dataIndex: "code" },
    { title: "名称", dataIndex: "name" },
    { title: "资金性质", dataIndex: "capital_type", render: (v: string) => CAPITAL_TYPE_LABEL[v] ?? v },
    {
      title: "启用",
      dataIndex: "is_active",
      render: (value: boolean) => (
        <StatusTag status={value ? "ACTIVE" : "DISABLED"} label={value ? "是" : "否"} />
      ),
    },
  ];

  return (
    <Card className="glass" title="业务类型主数据">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Typography.Paragraph type="secondary">
        新增业务无需改代码：配置编号前缀与资金路由后即可开单（BAS-02）。
      </Typography.Paragraph>
      <DataTable<OrderType>
        columns={columns}
        rows={rows}
        page={1}
        pageSize={Math.max(rows.length, 10)}
        total={rows.length}
        emptyText="暂无业务类型"
        onPageChange={() => undefined}
      />
      <PermissionGate
        permission="order-type.manage"
        fallback={<Typography.Paragraph type="secondary">当前角色无主数据维护权限。</Typography.Paragraph>}
      >
        <Typography.Paragraph type="secondary">
          业务类型的启停由后端主数据接口控制，本页只读展示。
        </Typography.Paragraph>
      </PermissionGate>
    </Card>
  );
}
