/** 经营规则配置（T19 / BAS-06-01~02）：定义 → 版本 → 审批 → 生效期。
 *
 * 页面必须持续强调的两条红线：
 * - **已发布版本不可改**，只能新建版本；
 * - **新版本生效期不得与已有版本重叠**。
 */
import { Card, Form, Input, Modal, Select, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  policyApi,
  type PolicyDefinition,
  type PolicyVersion,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import {
  DataTable,
  ErrorBanner,
  PageHeader,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";

const SCOPE_OPTIONS = [
  { value: "GLOBAL", label: "全局" },
  { value: "ORDER_TYPE", label: "按业务类型" },
  { value: "USER", label: "按人员" },
  { value: "POOL", label: "按资金池" },
];

type DefinitionFormValues = {
  policy_code: string;
  name: string;
  scope_type: string;
  scope_id?: string;
  description?: string;
};

type VersionFormValues = {
  effective_from: string;
  effective_to?: string;
  config: string;
  note?: string;
};

const today = () => new Date().toISOString().slice(0, 10);

export function PolicySettingsPanel() {
  const [definitions, setDefinitions] = useState<PolicyDefinition[]>([]);
  const [definitionId, setDefinitionId] = useState<number | null>(null);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [definitionModalOpen, setDefinitionModalOpen] = useState(false);
  const [versionModalOpen, setVersionModalOpen] = useState(false);
  const [editingVersion, setEditingVersion] = useState<PolicyVersion | null>(null);
  const [definitionForm] = Form.useForm<DefinitionFormValues>();
  const [versionForm] = Form.useForm<VersionFormValues>();
  const definitionScopeType = Form.useWatch("scope_type", definitionForm);

  const current = definitions.find((d) => d.id === definitionId) ?? null;

  const loadDefinitions = useCallback(async () => {
    try {
      const data = await policyApi.list();
      setDefinitions(data.items);
      setDefinitionId((prev) => prev ?? data.items[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void loadDefinitions();
  }, [loadDefinitions]);

  const loadVersions = useCallback(async () => {
    if (definitionId === null) {
      setVersions([]);
      return;
    }
    setLoading(true);
    try {
      const data = await policyApi.versions(definitionId);
      setVersions(data.items);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [definitionId]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActing(true);
      setError(null);
      try {
        await fn();
        await loadDefinitions();
        await loadVersions();
        return true;
      } catch (err) {
        setError(normalizeError(err));
        return false;
      } finally {
        setActing(false);
      }
    },
    [loadDefinitions, loadVersions],
  );

  const openDefinitionModal = () => {
    definitionForm.resetFields();
    definitionForm.setFieldValue("scope_type", "GLOBAL");
    setDefinitionModalOpen(true);
  };

  const openVersionModal = (version?: PolicyVersion) => {
    setEditingVersion(version ?? null);
    versionForm.setFieldsValue({
      effective_from: version?.effective_from ?? today(),
      effective_to: version?.effective_to ?? undefined,
      config: version ? JSON.stringify(version.config, null, 2) : "",
      note: version?.note ?? undefined,
    });
    setVersionModalOpen(true);
  };

  const submitDefinition = async (values: DefinitionFormValues) => {
    setActing(true);
    setError(null);
    try {
      const created = await policyApi.create({
        policy_code: values.policy_code,
        name: values.name,
        scope_type: values.scope_type,
        scope_id: values.scope_type === "GLOBAL" || !values.scope_id ? undefined : Number(values.scope_id),
        description: values.description || undefined,
      });
      const data = await policyApi.list();
      setDefinitions(data.items);
      setDefinitionId(created.id);
      setDefinitionModalOpen(false);
      definitionForm.resetFields();
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setActing(false);
    }
  };

  const submitVersion = async (values: VersionFormValues) => {
    if (!current) return;
    let config: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(values.config);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("规则参数必须是 JSON 对象");
      }
      config = parsed as Record<string, unknown>;
    } catch (err) {
      setError(normalizeError(err));
      return;
    }

    const succeeded = await act(() => editingVersion
      ? policyApi.updateDraft(editingVersion.id, config)
      : policyApi.createVersion(current.id, {
          effective_from: values.effective_from,
          effective_to: values.effective_to || undefined,
          config,
          note: values.note || undefined,
        }));
    if (!succeeded) return;
    setVersionModalOpen(false);
    setEditingVersion(null);
    versionForm.resetFields();
  };

  const versionColumns: ColumnsType<PolicyVersion> = [
    { title: "版本", dataIndex: "version", width: 80, render: (v: number) => `v${v}` },
    {
      title: "生效期",
      width: 200,
      render: (_v, row) => (
        <span className="muted">
          {row.effective_from} ~ {row.effective_to ?? "至今"}
        </span>
      ),
    },
    {
      title: "规则参数",
      dataIndex: "config",
      render: (config: Record<string, unknown>) => (
        <span className="muted">
          {Object.entries(config)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(" · ")}
        </span>
      ),
    },
    { title: "状态", dataIndex: "status", width: 110, render: (v: string) => <StatusTag status={v} /> },
    { title: "审批人", dataIndex: "approved_by", width: 100 },
    {
      title: "操作",
      width: 160,
      render: (_v, row) => (
        <Space size="small">
          <PermissionButton
            permission="policy.manage"
            size="small"
            loading={acting}
            disabled={row.status !== "DRAFT"}
            onClick={() => openVersionModal(row)}
          >
            编辑
          </PermissionButton>
          <PermissionButton
            permission="policy.approve"
            size="small"
            type="primary"
            loading={acting}
            disabled={row.status !== "DRAFT"}
            onClick={() => void act(() => policyApi.approve(row.id, {}))}
          >
            发布
          </PermissionButton>
        </Space>
      ),
    },
  ];

  return (
    <section className="ui-stack">
      <PageHeader
        title="经营规则"
        description="规则按版本与生效期管理；已发布版本不可修改，只能新建版本。"
        actions={
          <Space className="ui-filter-bar">
            <Select
              className="ui-control-width-policy"
              placeholder="选择规则"
              value={definitionId ?? undefined}
              options={definitions.map((d) => ({ value: d.id, label: `${d.name}（${d.policy_code}）` }))}
              onChange={setDefinitionId}
            />
            <PermissionButton
              permission="policy.manage"
              type="primary"
              loading={acting}
              onClick={openDefinitionModal}
            >
              新建规则
            </PermissionButton>
            {current ? (
              <PermissionButton
                permission="policy.manage"
                loading={acting}
                onClick={() => openVersionModal()}
              >
                新建版本
              </PermissionButton>
            ) : null}
          </Space>
        }
      />

      <ErrorBanner
        error={error}
        onRetry={() => void (definitionId === null ? loadDefinitions() : loadVersions())}
        retrying={loading}
      />

      <StatRow
        items={[
          { label: "规则总数", kind: "count", amount: String(definitions.length) },
          {
            label: "已发布",
            kind: "count",
            amount: String(versions.filter((v) => v.status === "ACTIVE").length),
          },
          { label: "草稿版本", kind: "count", amount: String(versions.filter((v) => v.status === "DRAFT").length) },
          { label: "当前规则", kind: "count", amount: current ? current.policy_code : "-" },
        ]}
      />

      <Card className="glass" title="规则定义">
        <Typography.Paragraph type="secondary">
          提成规则使用编码 COMMISSION，发布后会随新建订单固化版本快照；订单详情的“利润分配”再按买号、售出、运营、公司四项拆分，比例合计必须为 100%，返点收益不参与拆分。
        </Typography.Paragraph>
        <DataTable<PolicyDefinition>
          columns={[
            { title: "编码", dataIndex: "policy_code", width: 140 },
            { title: "名称", dataIndex: "name" },
            {
              title: "适用范围",
              dataIndex: "scope_type",
              width: 160,
              render: (v: string) => SCOPE_OPTIONS.find((o) => o.value === v)?.label ?? v,
            },
            { title: "范围 ID", dataIndex: "scope_id", width: 100, render: (v?: number | null) => v ?? "-" },
            { title: "状态", dataIndex: "status", width: 110, render: (v: string) => <StatusTag status={v} /> },
          ]}
          rows={definitions}
          page={1}
          pageSize={Math.max(definitions.length, 10)}
          total={definitions.length}
          emptyText="尚未配置经营规则"
          onPageChange={() => undefined}
        />
      </Card>

      {current ? (
        <Card className="glass" title={`版本历史 · ${current.name}`}>
          <Typography.Paragraph type="secondary">
            生效期采用左闭右开区间，相邻版本（前版本失效日 = 后版本生效日）不算重叠。
            发布只影响生效日之后的新建业务，不会回算历史。
          </Typography.Paragraph>
          <DataTable<PolicyVersion>
            columns={versionColumns}
            rows={versions}
            loading={loading}
            page={1}
            pageSize={Math.max(versions.length, 10)}
            total={versions.length}
            emptyText="该规则还没有版本"
            onPageChange={() => undefined}
          />
        </Card>
      ) : null}

      <Modal
        open={definitionModalOpen}
        title="新建经营规则"
        okText="创建规则"
        cancelText="取消"
        confirmLoading={acting}
        onCancel={() => setDefinitionModalOpen(false)}
        onOk={() => void definitionForm.submit()}
      >
        <Form form={definitionForm} layout="vertical" onFinish={submitDefinition}>
          <Form.Item name="policy_code" label="规则编码" rules={[{ required: true, message: "请输入规则编码" }]}>
            <Input placeholder="例如 REBATE_RATE" />
          </Form.Item>
          <Form.Item name="name" label="规则名称" rules={[{ required: true, message: "请输入规则名称" }]}>
            <Input placeholder="例如 返点比例" />
          </Form.Item>
          <Form.Item name="scope_type" label="适用范围" rules={[{ required: true, message: "请选择适用范围" }]}>
            <Select options={SCOPE_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="scope_id"
            label="范围 ID"
            rules={definitionScopeType && definitionScopeType !== "GLOBAL" ? [{ required: true, message: "请输入范围 ID" }] : []}
          >
            <Input type="number" min={1} placeholder="按人员、业务类型或资金池时填写" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={2} placeholder="可选，说明规则用途" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={versionModalOpen}
        title={editingVersion ? `编辑草稿 v${editingVersion.version}` : "新建规则版本"}
        okText="保存版本"
        cancelText="取消"
        confirmLoading={acting}
        onCancel={() => setVersionModalOpen(false)}
        onOk={() => void versionForm.submit()}
      >
        <Form form={versionForm} layout="vertical" onFinish={submitVersion}>
          <Space direction="horizontal" size="middle" className="policy-version-date-row">
            <Form.Item
              name="effective_from"
              label="生效日期"
              rules={[{ required: true, message: "请选择生效日期" }]}
              className="policy-version-date-row__item"
            >
              <Input type="date" />
            </Form.Item>
            <Form.Item name="effective_to" label="失效日期" className="policy-version-date-row__item">
              <Input type="date" />
            </Form.Item>
          </Space>
          <Form.Item
            name="config"
            label="规则参数"
            extra={'请输入 JSON 对象，例如 {"rate":"5"}。'}
            rules={[{ required: true, message: "请输入规则参数" }]}
          >
            <Input.TextArea rows={8} placeholder={'{\n  "rate": "5"\n}'} />
          </Form.Item>
          <Form.Item name="note" label="变更说明">
            <Input.TextArea rows={2} placeholder="可选，说明本次版本变更" />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}

