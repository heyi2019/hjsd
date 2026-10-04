/** 客户中心：客户档案与订单参与关系；合作方单独 Tab，不与客户混用（CUS-01 / A11）。 */
import { Card, Form, Input, Modal, Select, Space, Tabs, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  counterpartiesApi,
  customersApi,
  type Counterparty,
  type Customer,
} from "../shared/api/catalog";
import { errorMessage } from "../shared/api/client";
import {
  DataTable,
  ErrorBanner,
  PageHeader,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";

export function CustomersPage() {
  return (
    <section className="ui-stack">
      <PageHeader
        title="客户中心"
        description="客户档案与合作方严格分离；联系方式默认脱敏，完整信息按权限展示并留审计。"
      />
      <Tabs
        defaultActiveKey="customers"
        items={[
          { key: "customers", label: "客户档案", children: <CustomerPanel /> },
          { key: "counterparties", label: "合作方（同行/供货方/平台）", children: <CounterpartyPanel /> },
        ]}
      />
    </section>
  );
}

function CustomerPanel() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<Customer | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [form] = Form.useForm();
  const [mergeForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      setRows(await customersApi.list());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = async (values: Record<string, unknown>) => {
    try {
      const result = await customersApi.create({
        display_name: values.display_name as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
        qq: values.qq as string,
      });
      if (result.duplicate_candidates.length > 0) {
        message.warning(`已建档，检测到 ${result.duplicate_candidates.length} 条重复候选（未拦截）`);
      } else {
        message.success("客户已建档");
      }
      setCreateOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitMerge = async (values: Record<string, unknown>) => {
    if (!mergeTarget) return;
    try {
      await customersApi.merge(
        mergeTarget.id,
        Number(values.target_customer_id),
        values.reason as string,
      );
      message.success("合并完成，来源客户已置 MERGED 并迁移关联关系");
      setMergeTarget(null);
      mergeForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<Customer> = [
    { title: "客户编号", dataIndex: "customer_no" },
    { title: "称呼/昵称", dataIndex: "display_name" },
    { title: "手机", dataIndex: "phone" },
    { title: "微信", dataIndex: "wechat" },
    { title: "QQ", dataIndex: "qq" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <Space>
          <PermissionButton
            permission="customer.merge"
            size="small"
            disabled={row.status !== "ACTIVE"}
            onClick={() => setMergeTarget(row)}
          >
            合并
          </PermissionButton>
          <PermissionButton
            permission="customer.update"
            size="small"
            disabled={row.status !== "ACTIVE"}
            onClick={async () => {
              await customersApi.setStatus(row.id, "DISABLED");
              message.success("客户已停用，历史关系保留");
              await load();
            }}
          >
            停用
          </PermissionButton>
        </Space>
      ),
    },
  ];

  return (
    <Card
      className="glass"
      title="客户档案"
      extra={
        <PermissionButton permission="customer.create" type="primary" onClick={() => setCreateOpen(true)}>
          新建客户
        </PermissionButton>
      }
    >
      <ErrorBanner message={error?.message} code={error?.code} />
      <Typography.Paragraph type="secondary">
        联系方式默认脱敏；完整联系方式按权限展示并记录读取审计。停用/已合并客户不可作为新订单参与方。
      </Typography.Paragraph>
      <StatRow
        items={[
          { label: "客户总数", kind: "count", amount: String(rows.length) },
          { label: "启用中", kind: "count", amount: String(rows.filter((r) => r.status === "ACTIVE").length) },
          { label: "已停用", kind: "count", amount: String(rows.filter((r) => r.status === "DISABLED").length) },
        ]}
      />
      <DataTable<Customer>
        columns={columns}
        rows={rows}
        page={page}
        pageSize={pageSize}
        total={rows.length}
        emptyText="暂无客户档案"
        onPageChange={(nextPage, nextSize) => {
          setPage(nextPage);
          setPageSize(nextSize);
        }}
      />

      <Modal title="新建客户" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <Form form={form} layout="vertical" onFinish={submitCreate}>
          <Form.Item name="display_name" label="称呼/昵称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="contact_name" label="联系人姓名">
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="手机号">
            <Input />
          </Form.Item>
          <Form.Item name="wechat" label="微信号">
            <Input />
          </Form.Item>
          <Form.Item name="qq" label="QQ">
            <Input />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            联系方式允许重复；重复只提示候选，不拦截建档。
          </Typography.Paragraph>
          <PermissionButton permission="customer.create" type="primary" htmlType="submit">
            建档
          </PermissionButton>
        </Form>
      </Modal>

      <Modal
        title={mergeTarget ? `合并客户 · ${mergeTarget.customer_no}` : "合并客户"}
        open={Boolean(mergeTarget)}
        onCancel={() => setMergeTarget(null)}
        footer={null}
      >
        <Form form={mergeForm} layout="vertical" onFinish={submitMerge}>
          <Form.Item name="target_customer_id" label="目标客户（必须为 ACTIVE）" rules={[{ required: true }]}>
            <Select
              options={rows
                .filter((row) => row.status === "ACTIVE" && row.id !== mergeTarget?.id)
                .map((row) => ({ value: row.id, label: `${row.customer_no} ${row.display_name}` }))}
            />
          </Form.Item>
          <Form.Item name="reason" label="合并原因" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <PermissionButton permission="customer.merge" type="primary" htmlType="submit">
            确认合并
          </PermissionButton>
        </Form>
      </Modal>
    </Card>
  );
}

function CounterpartyPanel() {
  const [rows, setRows] = useState<Counterparty[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    try {
      setRows(await counterpartiesApi.list());
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
      await counterpartiesApi.create({
        display_name: values.display_name as string,
        type: values.type as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
      });
      message.success("合作方已建档");
      setOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<Counterparty> = [
    { title: "编号", dataIndex: "counterparty_no" },
    { title: "名称", dataIndex: "display_name" },
    { title: "类型", dataIndex: "type" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    {
      title: "操作",
      render: (_v, row) => (
        <PermissionButton
          permission="counterparty.manage"
          size="small"
          onClick={async () => {
            await counterpartiesApi.setStatus(row.id, row.status !== "ACTIVE");
            await load();
          }}
        >
          {row.status === "ACTIVE" ? "停用" : "启用"}
        </PermissionButton>
      ),
    },
  ];

  return (
    <Card
      className="glass"
      title="合作方"
      extra={
        <PermissionButton permission="counterparty.manage" type="primary" onClick={() => setOpen(true)}>
          新建合作方
        </PermissionButton>
      }
    >
      <ErrorBanner message={error?.message} code={error?.code} />
      <Typography.Paragraph type="secondary">
        同行、供货方、平台使用 CP 编号，与客户（CUS）严格分离；有历史参与关系仅可停用。
      </Typography.Paragraph>
      <DataTable<Counterparty>
        columns={columns}
        rows={rows}
        page={1}
        pageSize={Math.max(rows.length, 10)}
        total={rows.length}
        emptyText="暂无合作方"
        onPageChange={() => undefined}
      />
      <Modal title="新建合作方" open={open} onCancel={() => setOpen(false)} footer={null}>
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ type: "PEER" }}>
          <Form.Item name="display_name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "PEER", label: "同行" },
                { value: "SUPPLIER", label: "供货方" },
                { value: "PLATFORM", label: "平台" },
              ]}
            />
          </Form.Item>
          <Form.Item name="contact_name" label="联系人">
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="手机号">
            <Input />
          </Form.Item>
          <Form.Item name="wechat" label="微信号">
            <Input />
          </Form.Item>
          <PermissionButton permission="counterparty.manage" type="primary" htmlType="submit">
            建档
          </PermissionButton>
        </Form>
      </Modal>
    </Card>
  );
}

function normalizeError(err: unknown): { message: string; code?: string } {
  const detail = (err as { response?: { data?: { detail?: { message?: string; code?: string } } } })
    ?.response?.data?.detail;
  if (detail?.message) return { message: detail.message, code: detail.code };
  return { message: errorMessage(err) };
}
