/** 库存：以账号为载体的状态与成本（ACC-01 / RPT-01-01）。TH 永不进入库存。 */
import { Card, Form, Input, Select } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { accountsApi, type Account } from "../shared/api/catalog";
import { errorMessage } from "../shared/api/client";
import {
  DataTable,
  ErrorBanner,
  MoneyText,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";

const STATUS_OPTIONS = [
  { value: "IN_STOCK", label: "在库" },
  { value: "INSTALLMENT", label: "分期中" },
  { value: "FOR_SALE", label: "待售" },
  { value: "SOLD", label: "已售" },
  { value: "VOID", label: "失效" },
];

export function InventoryPanel() {
  const [rows, setRows] = useState<Account[]>([]);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const list = await accountsApi.list(status ? { status } : undefined);
      setRows(list);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const occupied = rows.filter((row) => ["IN_STOCK", "INSTALLMENT"].includes(row.status));
  const totalCost = occupied.reduce((sum, row) => sum + Number(row.cost_amount), 0).toFixed(2);

  const submit = async (values: Record<string, unknown>) => {
    try {
      await accountsApi.create({
        game_account: values.game_account as string,
        platform: values.platform as string,
      });
      form.resetFields();
      await load();
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<Account> = [
    { title: "账号编号", dataIndex: "account_no" },
    { title: "账号标识", dataIndex: "game_account" },
    { title: "平台", dataIndex: "platform" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    {
      title: "成本",
      dataIndex: "cost_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
  ];

  return (
    <section className="ui-stack">
      <ErrorBanner message={error?.message} code={error?.code} />

      <StatRow
        items={[
          { label: "在库 / 分期中", kind: "count", amount: String(occupied.length) },
          { label: "占用成本合计", amount: totalCost },
          { label: "已售", kind: "count", amount: String(rows.filter((r) => r.status === "SOLD").length) },
        ]}
      />

      <Card
        className="glass"
        title="账号台账"
        extra={
          <Select
            allowClear
            placeholder="按状态筛选"
            style={{ width: 180 }}
            value={status}
            options={STATUS_OPTIONS}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          />
        }
      >
        <DataTable<Account>
          columns={columns}
          rows={rows}
          page={page}
          pageSize={pageSize}
          total={rows.length}
          emptyText="暂无账号"
          onPageChange={(nextPage, nextSize) => {
            setPage(nextPage);
            setPageSize(nextSize);
          }}
        />
      </Card>

      <Card className="glass" title="新增账号">
        <Form form={form} layout="inline" onFinish={submit}>
          <Form.Item name="game_account" rules={[{ required: true, message: "账号标识必填" }]}>
            <Input placeholder="账号标识" />
          </Form.Item>
          <Form.Item name="platform">
            <Input placeholder="平台" />
          </Form.Item>
          <Form.Item>
            <PermissionButton permission="order.create" type="primary" htmlType="submit">
              建档
            </PermissionButton>
          </Form.Item>
        </Form>
      </Card>
    </section>
  );
}

function normalizeError(err: unknown): { message: string; code?: string } {
  const detail = (err as { response?: { data?: { detail?: { message?: string; code?: string } } } })
    ?.response?.data?.detail;
  if (detail?.message) return { message: detail.message, code: detail.code };
  return { message: errorMessage(err) };
}
