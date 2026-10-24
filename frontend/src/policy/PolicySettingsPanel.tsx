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
import { useSession } from "../shared/state/session";
import {
  DataTable,
  ErrorBanner,
  PageHeader,
  ConfirmButton,
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

/** 规则编码必须与后端 PolicyType 一致：后端按固定编码消费快照（返点/提成/分期），
 * 编码拼错不会报错，只会静默取不到规则，因此这里强制枚举选择。 */
const POLICY_CODE_OPTIONS = [
  { value: "REBATE", label: "REBATE 返点" },
  { value: "COMMISSION", label: "COMMISSION 提成" },
  { value: "INSTALLMENT", label: "INSTALLMENT 分期" },
  { value: "WRITE_DOWN", label: "WRITE_DOWN 跌价" },
  { value: "REFUND", label: "REFUND 退款" },
  { value: "DG_MIXED", label: "DG_MIXED DG 混合单默认策略" },
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

type ResolveFormValues = {
  policy_code: string;
  on: string;
  scope_type: string;
  scope_id?: string;
};

const today = () => new Date().toISOString().slice(0, 10);

export function PolicySettingsPanel() {
  const { can } = useSession();
  // 后端读取门控为 policy.manage / policy.approve 任一（policy/router.py policy_read_access）；
  // PermissionButton 只接受单权限码，故按当前用户实际持有的那个码门控（同 InstallmentsPanel settlePermission 先例）。
  const resolvePermission = can("policy.manage") ? "policy.manage" : "policy.approve";
  const [definitions, setDefinitions] = useState<PolicyDefinition[]>([]);
  const [definitionId, setDefinitionId] = useState<number | null>(null);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [definitionModalOpen, setDefinitionModalOpen] = useState(false);
  const [versionModalOpen, setVersionModalOpen] = useState(false);
  const [editingVersion, setEditingVersion] = useState<PolicyVersion | null>(null);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveResult, setResolveResult] = useState<{ found: boolean; version: PolicyVersion | null } | null>(null);
  const [definitionForm] = Form.useForm<DefinitionFormValues>();
  const [versionForm] = Form.useForm<VersionFormValues>();
  const [resolveForm] = Form.useForm<ResolveFormValues>();
  const definitionScopeType = Form.useWatch("scope_type", definitionForm);
  const resolveScopeType = Form.useWatch("scope_type", resolveForm);

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

  /** 生效期自查（BAS-06-04 依据）：解析某日某作用域实际命中的规则版本，配置错不错一查便知。 */
  const submitResolve = async (values: ResolveFormValues) => {
    setResolving(true);
    setError(null);
    try {
      setResolveResult(await policyApi.resolve(
        values.policy_code,
        values.on,
        {
          scope_type: values.scope_type || "GLOBAL",
          scope_id: values.scope_type && values.scope_type !== "GLOBAL" && values.scope_id ? Number(values.scope_id) : undefined,
        },
      ));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setResolving(false);
    }
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
          <ConfirmButton
            permission="policy.approve"
            size="small"
            type="primary"
            disabled={row.status !== "DRAFT"}
            title="发布该规则版本"
            description="发布后对生效日之后的新单生效；已发布版本不可修改，只能新建版本。"
            onConfirm={async () => {
              await act(() => policyApi.approve(row.id, {}));
            }}
          >
            发布
          </ConfirmButton>
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
            {can("policy.manage") || can("policy.approve") ? (
              <PermissionButton
                permission={resolvePermission}
                loading={resolving}
                onClick={() => {
                  resolveForm.resetFields();
                  resolveForm.setFieldsValue({ policy_code: current?.policy_code, on: today(), scope_type: "GLOBAL" });
                  setResolveResult(null);
                  setResolveOpen(true);
                }}
              >
                生效期自查
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
          <Form.Item name="policy_code" label="规则编码" rules={[{ required: true, message: "请选择规则编码" }]}>
            <Select options={POLICY_CODE_OPTIONS} placeholder="选择规则编码（与后端 PolicyType 一致）" />
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
      <Modal
        open={resolveOpen}
        title="规则生效期自查"
        okText="解析"
        cancelText="取消"
        confirmLoading={resolving}
        onCancel={() => setResolveOpen(false)}
        onOk={() => void resolveForm.submit()}
      >
        <Form form={resolveForm} layout="vertical" onFinish={submitResolve}>
          <Typography.Paragraph type="secondary">
            解析某个日期实际命中的规则版本——发布只影响生效日之后的新单，历史订单按建单时固化的快照计算，不随改版变化。
          </Typography.Paragraph>
          <Form.Item name="policy_code" label="规则编码" rules={[{ required: true, message: "请选择规则编码" }]}>
            <Select options={POLICY_CODE_OPTIONS} placeholder="选择规则编码" />
          </Form.Item>
          <Form.Item name="on" label="生效日期" rules={[{ required: true, message: "请选择生效日期" }]}>
            <Input type="date" />
          </Form.Item>
          <Form.Item name="scope_type" label="适用范围" initialValue="GLOBAL" rules={[{ required: true, message: "请选择适用范围" }]}>
            <Select options={SCOPE_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="scope_id"
            label="范围 ID"
            rules={resolveScopeType && resolveScopeType !== "GLOBAL" ? [{ required: true, message: "请输入范围 ID" }] : []}
          >
            <Input type="number" min={1} placeholder="按人员、业务类型或资金池时填写" />
          </Form.Item>
        </Form>
        {resolveResult ? (
          resolveResult.found && resolveResult.version ? (
            <Typography.Paragraph>
              命中版本 <b>v{resolveResult.version.version}</b>（{resolveResult.version.effective_from} ~ {resolveResult.version.effective_to ?? "至今"}，
              状态 {resolveResult.version.status}）：{Object.entries(resolveResult.version.config).map(([key, value]) => `${key}=${String(value)}`).join(" · ")}
            </Typography.Paragraph>
          ) : (
            <Typography.Paragraph type="warning">该日该作用域没有生效的规则版本，新单不会套用此规则。</Typography.Paragraph>
          )
        ) : null}
      </Modal>
    </section>
  );
}

