import { Card, Descriptions, Drawer, Form, Input, Space, Spin, Typography } from "antd";
import { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../orders/ConfigurableField";
import { counterpartiesApi, orderFormFieldsApi } from "../shared/api/catalog";
import type { Counterparty, OrderFormField } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { COUNTERPARTY_TYPE_LABEL } from "../shared/lib/labels";
import { useOptionSet } from "../shared/lib/optionSets";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import { DataTable, BusinessActionModal, BusinessForm, ErrorBanner, ConfirmButton, PermissionButton, Select, StatusTag, useCompactLayout } from "../shared/ui";
import { appMessage } from "../shared/ui/appFeedback";
import { MobileCounterpartyList, collectExtras } from "./CustomersPage.fragments";

const COUNTERPARTY_STATUS_OPTIONS = [
  { value: "ACTIVE", label: "进行中" },
  { value: "DISABLED", label: "已拉黑" },
];

// 类型词典不可用时回落的只读集合：保证默认类型 PEER 始终是带名称的 selected option，
// 避免出现"控件外游离文本 PEER"。来源与 COUNTERPARTY_TYPE_LABEL 一致（含 PEER/SUPPLIER/PLATFORM 等）。
const COUNTERPARTY_TYPE_FALLBACK = Object.entries(COUNTERPARTY_TYPE_LABEL).map(([value, label]) => ({ value, label }));

export function CounterpartyPanel({ active = true, focusId }: { active?: boolean; focusId?: number }) {
  const compact = useCompactLayout();
  const counterpartyTypeOptions = useOptionSet("COUNTERPARTY_TYPE");
  const counterpartyStatusOptions = useOptionSet("COUNTERPARTY_STATUS");
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<Counterparty[]>([]);
  const [fieldDefs, setFieldDefs] = useState<OrderFormField[]>([]);
  const [open, setOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Counterparty | null>(null);
  const [detailTarget, setDetailTarget] = useState<Counterparty | null>(null);
  const [detailData, setDetailData] = useState<Counterparty | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      setRows(await counterpartiesApi.list());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  // keep-alive：提号建单会自动建档供货方，重新激活时重拉避免列表过期。
  useReloadOnActive(active, load);

  useEffect(() => {
    orderFormFieldsApi.list("COUNTERPARTY", true)
      .then((items) => setFieldDefs((items ?? []).filter((item) => item.is_custom)))
      .catch(() => setFieldDefs([]));
  }, []);

  const openDetail = async (row: Counterparty) => {
    setDetailTarget(row);
    setDetailData(null);
    setDetailLoading(true);
    try {
      setDetailData(await counterpartiesApi.get(row.id));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const handledFocusRef = useRef<number | null>(null);
  useEffect(() => {
    if (focusId == null || handledFocusRef.current === focusId) return;
    const row = rows.find((item) => item.id === focusId);
    if (!row) return;
    handledFocusRef.current = focusId;
    void openDetail(row);
  }, [focusId, rows]);

  const submit = async (values: Record<string, unknown>) => {
    try {
      await counterpartiesApi.create({
        display_name: values.display_name as string,
        type: values.type as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
        qq: values.qq as string,
        note: (values.note as string) || null,
        extra_values: collectExtras(values, fieldDefs),
      });
      appMessage.success("合作方已建档");
      setOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitEdit = async (values: Record<string, unknown>) => {
    if (!editTarget) return;
    try {
      await counterpartiesApi.patch(editTarget.id, {
        display_name: values.display_name as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
        qq: values.qq as string,
        note: (values.note as string) || null,
        extra_values: collectExtras(values, fieldDefs),
      });
      appMessage.success("合作方已更新");
      setEditTarget(null);
      editForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<Counterparty> = [
    { title: "编号", dataIndex: "counterparty_no" },
    { title: "名称", dataIndex: "display_name" },
    { title: "类型", dataIndex: "type", render: (v: string) => COUNTERPARTY_TYPE_LABEL[v] ?? v },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} optionSet="COUNTERPARTY_STATUS" /> },
    {
      title: "操作",
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton permission="counterparty.read" size="small" onClick={() => void openDetail(row)}>
            详情
          </PermissionButton>
          <PermissionButton permission="counterparty.manage" size="small" disabled={row.status !== "ACTIVE"} onClick={() => setEditTarget(row)}>
            编辑
          </PermissionButton>
          <ConfirmButton
            permission="counterparty.manage"
            size="small"
            title={row.status === "ACTIVE" ? "拉黑该合作方" : "解除拉黑"}
            description={row.status === "ACTIVE"
              ? "拉黑后不可作为新订单对手方；有历史参与关系的仅可拉黑，不可删除。"
              : "解除后可重新作为新订单对手方。"}
            danger={row.status === "ACTIVE"}
            onConfirm={async () => {
              await counterpartiesApi.setStatus(row.id, row.status !== "ACTIVE");
              appMessage.success(row.status === "ACTIVE" ? "合作方已拉黑，历史关系保留" : "合作方已解除拉黑");
              await load();
            }}
          >
            {row.status === "ACTIVE" ? "拉黑" : "解除拉黑"}
          </ConfirmButton>
        </Space>
      ),
    },
  ];

  const visibleCounterparties = statusFilter ? rows.filter((r) => r.status === statusFilter) : rows;

  return (
    <Card
      className="glass"
      title="合作方"
      extra={
        <PermissionButton permission="counterparty.manage" type="primary" disabled={Boolean(error) || !counterpartyTypeOptions} onClick={() => setOpen(true)}>
          新建合作方
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Space wrap className="counterparty-filter-bar">
        <Select allowClear placeholder="按状态筛选" className="ui-control-width-inventory" aria-label="合作方状态" value={statusFilter} options={counterpartyStatusOptions ?? COUNTERPARTY_STATUS_OPTIONS} onChange={(value) => setStatusFilter(value)} />
      </Space>
      <Typography.Paragraph type="secondary">
        同行、供货方、平台使用 CP 编号，与客户（CUS）严格分离；有历史参与关系仅可拉黑。
      </Typography.Paragraph>
      {!compact ? <DataTable<Counterparty>
        columns={columns}
        rows={visibleCounterparties}
        page={1}
        pageSize={10}
        total={visibleCounterparties.length}
        emptyText="暂无合作方"
        onPageChange={() => undefined}
     /> : <MobileCounterpartyList
        rows={rows}
        onDetail={(row) => void openDetail(row)}
        onEdit={setEditTarget}
        onToggle={async (row) => {
          await counterpartiesApi.setStatus(row.id, row.status !== "ACTIVE");
          appMessage.success(row.status === "ACTIVE" ? "合作方已拉黑，历史关系保留" : "合作方已解除拉黑");
          await load();
        }}
      />}
      <BusinessActionModal title="新建合作方" open={open} onCancel={() => setOpen(false)} footer={null}>
        <FieldConfigScope scope="COUNTERPARTY" active={open}>
        <BusinessForm scope="COUNTERPARTY" form={form} colon={false} className="form-no-colon" onFinish={submit} initialValues={{ type: "PEER" }}>
          <CfgItem name="display_name" label="名称" rules={[{ required: true }]}>
            <Input />
          </CfgItem>
          <CfgItem name="type" label="类型" rules={[{ required: true }]}>
            <Select options={counterpartyTypeOptions ?? COUNTERPARTY_TYPE_FALLBACK} />
          </CfgItem>
          <CfgItem name="contact_name" label="联系人">
            <Input />
          </CfgItem>
          <CfgItem name="phone" label="手机号">
            <Input />
          </CfgItem>
          <CfgItem name="wechat" label="微信号">
            <Input />
          </CfgItem>
          <CustomFieldSection testIdSuffix="counterparty-create" />
          <PermissionButton permission="counterparty.manage" type="primary" htmlType="submit" disabled={Boolean(error) || !counterpartyTypeOptions}>
            建档
          </PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </BusinessActionModal>

      <BusinessActionModal
        title={editTarget ? `编辑合作方 · ${editTarget.counterparty_no}` : "编辑合作方"}
        open={Boolean(editTarget)}
        onCancel={() => {
          setEditTarget(null);
          editForm.resetFields();
        }}
        footer={null}
        destroyOnHidden
      >
        <FieldConfigScope scope="COUNTERPARTY" active={Boolean(editTarget)}>
        <BusinessForm
          scope="COUNTERPARTY"
          form={editForm}
          layout="vertical"
          colon={false}
          className="form-no-colon"
          onFinish={submitEdit}
          initialValues={
            editTarget
              ? {
                  display_name: editTarget.display_name,
                  contact_name: editTarget.contact_name ?? "",
                  phone: editTarget.phone ?? "",
                  wechat: editTarget.wechat ?? "",
                  qq: editTarget.qq ?? "",
                  note: editTarget.note ?? "",
                }
              : undefined
          }
        >
          <Form.Item name="display_name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <div className="form-cols-2">
            <Form.Item name="contact_name" label="联系人">
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
          </div>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
          <CustomFieldSection testIdSuffix="counterparty-edit" />
          <PermissionButton permission="counterparty.manage" type="primary" htmlType="submit">
            保存
          </PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </BusinessActionModal>

      <Drawer
        title={detailTarget ? `合作方档案 · ${detailTarget.counterparty_no}` : "合作方档案"}
        open={Boolean(detailTarget)}
        onClose={() => {
          setDetailTarget(null);
          setDetailData(null);
        }}
        width={640}
        destroyOnHidden
        extra={
          detailTarget && detailTarget.status === "ACTIVE" ? (
            <PermissionButton
              permission="counterparty.manage"
              size="small"
              onClick={() => {
                setEditTarget(detailTarget);
                setDetailTarget(null);
              }}
            >
              编辑
            </PermissionButton>
          ) : null
        }
      >
        {detailLoading ? (
          <div role="status" aria-label="正在加载合作方详情"><Spin /></div>
        ) : detailData ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="合作方编号">{detailData.counterparty_no}</Descriptions.Item>
            <Descriptions.Item label="名称">{detailData.display_name}</Descriptions.Item>
            <Descriptions.Item label="类型">{COUNTERPARTY_TYPE_LABEL[detailData.type] ?? detailData.type}</Descriptions.Item>
            <Descriptions.Item label="联系人">{detailData.contact_name || "-"}</Descriptions.Item>
            <Descriptions.Item label="手机">{detailData.phone || "-"}</Descriptions.Item>
            <Descriptions.Item label="微信">{detailData.wechat || "-"}</Descriptions.Item>
            <Descriptions.Item label="QQ">{detailData.qq || "-"}</Descriptions.Item>
            <Descriptions.Item label="状态"><StatusTag status={detailData.status} optionSet="COUNTERPARTY_STATUS" /></Descriptions.Item>
            <Descriptions.Item label="备注">{detailData.note || "-"}</Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>
    </Card>
  );
}

