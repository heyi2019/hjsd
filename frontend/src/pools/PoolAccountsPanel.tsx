/** 资金池内账户（银行/现金/第三方渠道）主数据维护：归属决定计入权益还是仅计头寸（V30）。 */
import { Card, Form, Input, Modal, Select, Space, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { normalizeError } from "../shared/api/client";
import { poolAccountsApi, poolsApi, type Pool, type PoolAccount } from "../shared/api/catalog";
import {
  ConfirmButton,
  DataTable,
  ErrorBanner,
  MoneyInput,
  PermissionButton,
  StatusTag,
} from "../shared/ui";
import { requiredMoneyRules } from "../shared/lib/validators";
import { configurableLabel } from "../shared/lib/optionSets";
import { CfgItem, FieldConfigScope } from "../orders/ConfigurableField";

const OWNERSHIP_LABEL: Record<string, string> = {
  OWNED: "自有（计入权益）",
  CUSTODY: "代管（只计头寸）",
  THIRD_PART: "第三方（只计头寸）",
};
const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  BANK: "银行账户",
  CASH: "现金",
  THIRD_PARTY: "第三方渠道",
};

export function PoolAccountsPanel() {
  const [rows, setRows] = useState<PoolAccount[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [poolFilter, setPoolFilter] = useState<number | undefined>();
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<PoolAccount | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await poolAccountsApi.list(poolFilter);
      setRows(list ?? []);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [poolFilter]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    poolsApi.list().then((list) => setPools(list ?? [])).catch(() => setPools([]));
  }, []);

  const poolName = (poolId: number) => {
    const pool = pools.find((item) => item.id === poolId);
    return pool ? `${pool.name}（${pool.code}）` : `#${poolId}`;
  };

  const submitCreate = async (values: Record<string, unknown>) => {
    setSubmitting(true);
    try {
      await poolAccountsApi.create({
        pool_id: Number(values.pool_id),
        account_no: String(values.account_no).trim(),
        account_name: String(values.account_name).trim(),
        account_type: String(values.account_type),
        ownership: String(values.ownership),
        opening_balance: String(values.opening_balance ?? "0"),
        note: values.note ? String(values.note) : undefined,
      });
      message.success("池内账户已创建");
      setCreateOpen(false);
      createForm.resetFields();
      await load();
    } catch (err) {
      message.error(normalizeError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitEdit = async (values: Record<string, unknown>) => {
    if (!editTarget) return;
    setSubmitting(true);
    try {
      await poolAccountsApi.update(editTarget.id, {
        account_name: values.account_name ? String(values.account_name).trim() : undefined,
        account_type: values.account_type ? String(values.account_type) : undefined,
        ownership: values.ownership ? String(values.ownership) : undefined,
        opening_balance: values.opening_balance ? String(values.opening_balance) : undefined,
        note: values.note ? String(values.note) : undefined,
      });
      message.success("池内账户已更新");
      setEditTarget(null);
      editForm.resetFields();
      await load();
    } catch (err) {
      message.error(normalizeError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleStatus = async (row: PoolAccount) => {
    const next = row.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    try {
      await poolAccountsApi.setStatus(row.id, next);
      message.success(next === "ACTIVE" ? "账户已启用" : "账户已停用");
      await load();
    } catch (err) {
      message.error(normalizeError(err).message);
    }
  };

  const columns: ColumnsType<PoolAccount> = [
    { title: "所属资金池", key: "pool", render: (_v, row) => poolName(row.pool_id) },
    { title: "账号编号", dataIndex: "account_no" },
    { title: "账户名称", dataIndex: "account_name" },
    { title: "类型", dataIndex: "account_type", render: (v: string) => configurableLabel("POOL_ACCOUNT_TYPE", v, ACCOUNT_TYPE_LABEL) },
    {
      title: "归属",
      dataIndex: "ownership",
      render: (v: string) => (
        <StatusTag
          status={v === "OWNED" ? "ACTIVE" : "PENDING"}
          label={OWNERSHIP_LABEL[v] ?? v}
        />
      ),
    },
    { title: "期初余额", dataIndex: "opening_balance", align: "right", render: (v: string) => `¥${v}` },
    { title: "当前余额", dataIndex: "current_balance", align: "right", render: (v: string) => `¥${v}` },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={configurableLabel("POOL_ACCOUNT_STATUS", v, { ACTIVE: "启用", DISABLED: "停用" })} /> },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v || "-" },
    {
      title: "操作",
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton
            permission="pool.manage"
            size="small"
            onClick={() => {
              editForm.setFieldsValue({
                account_name: row.account_name,
                account_type: row.account_type,
                ownership: row.ownership,
                opening_balance: row.opening_balance,
                note: row.note ?? "",
              });
              setEditTarget(row);
            }}
          >
            编辑
          </PermissionButton>
          <ConfirmButton
            permission="pool.manage"
            size="small"
            danger={row.status === "ACTIVE"}
            title={row.status === "ACTIVE" ? `停用账户「${row.account_name}」` : `启用账户「${row.account_name}」`}
            description="停用后不能作为收付款账户登记新流水；历史流水不受影响。"
            onConfirm={() => toggleStatus(row)}
          >
            {row.status === "ACTIVE" ? "停用" : "启用"}
          </ConfirmButton>
        </Space>
      ),
    },
  ];

  return (
    <Card
      className="glass"
      title="池内账户主数据"
      extra={
        <PermissionButton permission="pool.manage" type="primary" onClick={() => { createForm.resetFields(); setCreateOpen(true); }}>
          新建账户
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Typography.Paragraph type="secondary">
        账户归属决定核算口径：OWNED 计入权益，CUSTODY / THIRD_PART 只计现金头寸。
      </Typography.Paragraph>
      <div className="ui-filter-bar">
        <Select
          allowClear
          aria-label="按资金池筛选"
          placeholder="全部资金池"
          value={poolFilter}
          onChange={(value) => setPoolFilter(value)}
          options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))}
        />
      </div>
      <DataTable<PoolAccount>
        columns={columns}
        rows={rows}
        page={1}
        pageSize={Math.max(rows.length, 10)}
        total={rows.length}
        emptyText="暂无池内账户"
        loading={loading}
        onPageChange={() => undefined}
      />

      <Modal
        title="新建池内账户"
        open={createOpen}
        confirmLoading={submitting}
        onCancel={() => setCreateOpen(false)}
        okText="创建"
        onOk={() => void createForm.submit()}
      >
        <FieldConfigScope scope="POOLACCOUNT" active={createOpen}>
        <Form form={createForm} layout="vertical" onFinish={submitCreate} initialValues={{ opening_balance: "0", account_type: "BANK", ownership: "OWNED" }}>
          <Form.Item name="pool_id" label="所属资金池" rules={[{ required: true, message: "请选择资金池" }]}>
            <Select placeholder="请选择资金池" options={pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} />
          </Form.Item>
          <Form.Item name="account_no" label="账号编号" rules={[{ required: true, message: "请输入账号编号" }]}>
            <Input placeholder="例如 ABC-8678" maxLength={64} />
          </Form.Item>
          <Form.Item name="account_name" label="账户名称" rules={[{ required: true, message: "请输入账户名称" }]}>
            <Input placeholder="例如 农行卡 8678" maxLength={128} />
          </Form.Item>
          <CfgItem name="account_type" label="账户类型" rules={[{ required: true }]}>
            <Select />
          </CfgItem>
          <CfgItem name="ownership" label="归属" rules={[{ required: true }]} extra="OWNED 计入权益；CUSTODY / THIRD_PART 只计现金头寸">
            <Select />
          </CfgItem>
          <Form.Item name="opening_balance" label="期初余额" rules={requiredMoneyRules("期初余额")}>
            <MoneyInput />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>
        </Form>
        </FieldConfigScope>
      </Modal>

      <Modal
        title={editTarget ? `编辑账户 · ${editTarget.account_name}` : "编辑账户"}
        open={Boolean(editTarget)}
        confirmLoading={submitting}
        onCancel={() => { setEditTarget(null); editForm.resetFields(); }}
        okText="保存"
        onOk={() => void editForm.submit()}
      >
        <FieldConfigScope scope="POOLACCOUNT" active={Boolean(editTarget)}>
        <Form form={editForm} layout="vertical" onFinish={submitEdit}>
          <Form.Item label="账号编号"><Input value={editTarget?.account_no} disabled /></Form.Item>
          <Form.Item name="account_name" label="账户名称" rules={[{ required: true, message: "请输入账户名称" }]}>
            <Input maxLength={128} />
          </Form.Item>
          <CfgItem name="account_type" label="账户类型" rules={[{ required: true }]}>
            <Select />
          </CfgItem>
          <CfgItem name="ownership" label="归属" rules={[{ required: true }]}>
            <Select />
          </CfgItem>
          <Form.Item name="opening_balance" label="期初余额" rules={requiredMoneyRules("期初余额")}>
            <MoneyInput />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>
        </Form>
        </FieldConfigScope>
      </Modal>
    </Card>
  );
}
