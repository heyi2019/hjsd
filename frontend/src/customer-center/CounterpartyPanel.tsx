import { TimeOrderControl } from "../shared/ui/TimeOrderControl";
import { SearchOutlined } from "@ant-design/icons";
import { ToolbarSelect } from "../shared/ui/ToolbarSelect";
import { Card, Descriptions, Drawer, Form, Input, Space, Spin, Typography } from "antd";
import { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { buildFormExtraDisplay, CfgItem, CustomFieldSection, FieldConfigScope, formatExtraDisplayValue, useOrderFormConfig } from "../business/ConfigurableField";
import { counterpartiesApi } from "../shared/api/customers.api";
import type { Counterparty } from "../shared/api/types/customers";
import { normalizeError } from "../shared/api/client";
import { configurableLabel, useOptionSet } from "../shared/lib/optionSets";
import { money } from "../shared/lib/format";
import { orderTypeLabel } from "../shared/lib/labels";
import { useListViewColumns } from "../shared/lib/listColumns";
import { DataTable, BusinessActionModal, BusinessRegistrationForm, ErrorBanner, InlineError, ConfirmButton, PermissionButton, Select, StatRow, StatusTag } from "../shared/ui";
import { appMessage } from "../shared/ui/appFeedback";
import { ToolbarMultiSelect } from "../shared/ui/ToolbarMultiSelect";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { useEmployeeOptions } from "../shared/hooks/useEmployeeOptions";
import { collectExtras } from "./CustomersPage.fragments";

export function CounterpartyPanel({ active = true, focusId, createdPeriod, createdPicker }: { active?: boolean; focusId?: number; createdPeriod?: { from: string; to: string } | null; createdPicker?: ReactNode }) {
  const counterpartyTypeOptions = useOptionSet("COUNTERPARTY_TYPE");
  const counterpartyStatusOptions = useOptionSet("COUNTERPARTY_STATUS");
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [searchInput, setSearchInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [creatorFilter, setCreatorFilter] = useState<string[]>([]);
  const { activeEmployees, settled: employeesSettled } = useEmployeeOptions();
  const creatorOptions = employeesSettled ? activeEmployees.map((item) => ({ label: item.display_name || item.username, value: item.username })) : null;
  const requestRef = useRef(0);
  const [rows, setRows] = useState<Counterparty[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const { config: fieldConfig, ready: fieldConfigReady, error: fieldConfigError, retry: retryFieldConfig } = useOrderFormConfig("COUNTERPARTY");
  const fieldDefs = Object.values(fieldConfig).filter((field) => field.is_custom);
  const [open, setOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Counterparty | null>(null);
  const [detailTarget, setDetailTarget] = useState<Counterparty | null>(null);
  const [detailData, setDetailData] = useState<Counterparty | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const write = useAsyncAction();
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const collectCounterpartyExtras = (values: Record<string, unknown>, includeEmpty = false) => {
    const formExtra = values.form_extra;
    const nestedValues = formExtra && typeof formExtra === "object" && !Array.isArray(formExtra)
      ? formExtra as Record<string, unknown>
      : {};
    return collectExtras(nestedValues, fieldDefs, { includeEmpty });
  };

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const response = await counterpartiesApi.page({
        ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(creatorFilter.length > 0 ? { created_by: creatorFilter } : {}),
        ...(createdPeriod ? { created_from: createdPeriod.from, created_to: createdPeriod.to } : {}),
        ...(sortDesc ? {} : { sort_desc: false }),
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      if (request !== requestRef.current) return;
      setRows(response.items);
      setTotal(response.total);
      setError(null);
    } catch (err) {
      if (request === requestRef.current) setError(normalizeError(err));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [creatorFilter, keyword, page, pageSize, sortDesc, statusFilter, createdPeriod?.from, createdPeriod?.to]);

  const resetKey = JSON.stringify([createdPeriod?.from, createdPeriod?.to]);
  const previousResetKey = useRef(resetKey);
  // 周期变化时先回到第一页，避免请求新周期的旧页码。
  useEffect(() => {
    if (!active) return;
    if (previousResetKey.current !== resetKey) {
      previousResetKey.current = resetKey;
      if (page !== 1) {
        setPage(1);
        return;
      }
    }
    void load();
    return () => { requestRef.current += 1; };
  }, [active, load, page, resetKey]);

  const openDetail = async (row: Counterparty, loadedDetail?: Counterparty) => {
    setDetailTarget(row);
    setDetailData(loadedDetail ?? null);
    setDetailLoading(!loadedDetail);
    if (loadedDetail) return;
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
    const row = rows?.find((item) => item.id === focusId);
    handledFocusRef.current = focusId;
    if (row) {
      void openDetail(row);
      return;
    }
    void counterpartiesApi.get(focusId)
      .then((item) => openDetail(item, item))
      .catch((err) => setError(normalizeError(err)));
  }, [focusId, rows]);

  const submit = async (values: Record<string, unknown>) => {
    if (!fieldConfigReady) return;
    await write.run(async () => {
      await counterpartiesApi.create({
        display_name: values.display_name as string,
        type: values.type as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
        qq: values.qq as string,
        note: (values.note as string) || null,
        extra_values: collectCounterpartyExtras(values),
      });
      appMessage.success("合作方已建档");
      setOpen(false);
      form.resetFields();
      await load();
    });
  };

  const submitEdit = async (values: Record<string, unknown>) => {
    if (!editTarget || !fieldConfigReady) return;
    await write.run(async () => {
      await counterpartiesApi.patch(editTarget.id, {
        display_name: values.display_name as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
        qq: values.qq as string,
        note: (values.note as string) || null,
        extra_values: collectCounterpartyExtras(values, true),
      });
      appMessage.success("合作方已更新");
      setEditTarget(null);
      editForm.resetFields();
      await load();
    });
  };

  const { arrange: arrangeColumns } = useListViewColumns("COUNTERPARTY");
  const columns: ColumnsType<Counterparty> = [
    {
      title: "编号",
      dataIndex: "counterparty_no",
      render: (value: string, row) => (
        <Typography.Link
          href="#"
          onClick={(event) => {
            event.preventDefault();
            void openDetail(row);
          }}
        >
          {value}
        </Typography.Link>
      ),
    },
    { title: "名称", dataIndex: "display_name" },
    { title: "类型", dataIndex: "type", render: (v: string) => configurableLabel("COUNTERPARTY_TYPE", v) },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} optionSet="COUNTERPARTY_STATUS" /> },
    { title: "创建操作人", dataIndex: "created_by", render: (v: string | null | undefined) => v || "-" },
    {
      title: "操作",
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton permission="counterparty.read" size="small" onClick={() => void openDetail(row)}>
            详情
          </PermissionButton>
          <PermissionButton permission="counterparty.manage" size="small" disabled={row.status !== "ACTIVE"} onClick={() => { write.clearError(); setEditTarget(row); }}>
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
  return (
    <Card
      className="glass"
      title="合作方"
      extra={
        <PermissionButton permission="counterparty.manage" type="primary" disabled={Boolean(error) || rows === null || !counterpartyTypeOptions} onClick={() => { write.clearError(); setOpen(true); }}>
          新建合作方
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Space wrap className="counterparty-filter-bar">
        <Input.Search type="search" aria-label="搜索合作方" maxLength={128} allowClear value={searchInput}
          placeholder="搜索合作方编号 / 名称 / 联系方式" enterButton={<SearchOutlined />}
          onChange={(event) => { setSearchInput(event.target.value); if (!event.target.value) { setKeyword(""); setPage(1); } }}
          onSearch={(value) => { setKeyword(value); setPage(1); }} />
        {createdPicker}
        <ToolbarSelect allowClear placeholder="按状态筛选" aria-label="合作方状态" value={statusFilter} options={counterpartyStatusOptions ?? []} disabled={counterpartyStatusOptions === null || rows === null} onChange={(value) => { setStatusFilter(value); setPage(1); }} />
        <ToolbarMultiSelect allowClear placeholder="创建操作人" aria-label="合作方创建操作人筛选" selectedLabels={creatorFilter.map((value) => creatorOptions?.find((option) => option.value === value)?.label ?? value)} value={creatorFilter} options={creatorOptions ?? []} disabled={creatorOptions === null || rows === null} onChange={(value) => { setCreatorFilter(value as string[]); setPage(1); }} />
        <TimeOrderControl descending={sortDesc} onChange={(value) => { setSortDesc(value); setPage(1); }} />
      </Space>
      <DataTable<Counterparty>
        columns={arrangeColumns(columns)}
        rows={error ? [] : rows ?? []}
        loading={loading || (rows === null && !error)}
        page={page}
        pageSize={pageSize}
        total={error ? 0 : total}
        controlledPaging
        emptyText={error ? "合作方数据不可用，请点击重新加载" : "暂无合作方"}
        onPageChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
     />
      <BusinessActionModal title="新建合作方" fieldCount={5} open={open} onCancel={() => { write.clearError(); setOpen(false); }} footer={null}>
        <InlineError error={write.error} />
        <ErrorBanner error={fieldConfigError} onRetry={retryFieldConfig} />
        <FieldConfigScope scope="COUNTERPARTY" active={open}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="COUNTERPARTY" form={form} colon={false} className="form-no-colon" onFinish={submit} initialValues={{ type: "PEER" }}>
          <CfgItem name="display_name" label="名称" rules={[{ required: true }]}>
            <Input />
          </CfgItem>
          <CfgItem name="type" label="类型" rules={[{ required: true }]}>
            <Select options={counterpartyTypeOptions ?? []} />
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
          <PermissionButton permission="counterparty.manage" type="primary" htmlType="submit" loading={write.pending} disabled={Boolean(error) || !counterpartyTypeOptions || !fieldConfigReady}>
            建档
          </PermissionButton>
        </BusinessRegistrationForm>
        </FieldConfigScope>
      </BusinessActionModal>

      <BusinessActionModal
        title={editTarget ? `编辑合作方 · ${editTarget.counterparty_no}` : "编辑合作方"}
        fieldCount={6}
        open={Boolean(editTarget)}
        onCancel={() => {
          write.clearError();
          setEditTarget(null);
          editForm.resetFields();
        }}
        footer={null}
        destroyOnHidden
      >
        <InlineError error={write.error} />
        <ErrorBanner error={fieldConfigError} onRetry={retryFieldConfig} />
        <FieldConfigScope scope="COUNTERPARTY" active={Boolean(editTarget)}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
          scope="COUNTERPARTY"
          form={editForm}
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
                  form_extra: editTarget.extra_values ?? {},
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
          <PermissionButton permission="counterparty.manage" type="primary" htmlType="submit" loading={write.pending} disabled={!fieldConfigReady}>
            保存
          </PermissionButton>
        </BusinessRegistrationForm>
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
                write.clearError();
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
          <>
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="合作方编号">{detailData.counterparty_no}</Descriptions.Item>
            <Descriptions.Item label="名称">{detailData.display_name}</Descriptions.Item>
            <Descriptions.Item label="类型">{configurableLabel("COUNTERPARTY_TYPE", detailData.type)}</Descriptions.Item>
            <Descriptions.Item label="联系人">{detailData.contact_name || "-"}</Descriptions.Item>
            <Descriptions.Item label="手机">{detailData.phone || "-"}</Descriptions.Item>
            <Descriptions.Item label="微信">{detailData.wechat || "-"}</Descriptions.Item>
            <Descriptions.Item label="QQ">{detailData.qq || "-"}</Descriptions.Item>
            <Descriptions.Item label="状态"><StatusTag status={detailData.status} optionSet="COUNTERPARTY_STATUS" /></Descriptions.Item>
            <Descriptions.Item label="创建操作人">{detailData.created_by || "-"}</Descriptions.Item>
            <Descriptions.Item label="备注">{detailData.note || "-"}</Descriptions.Item>
          </Descriptions>
          {detailData.overview ? (
            <StatRow
              className="counterparty-detail-stats"
              items={[
                { label: "订单数", kind: "count", amount: detailData.overview.order_count, testId: "counterparty-detail-order-count" },
                { label: "累计利润", amount: detailData.overview.cumulative_profit, kind: "money", testId: "counterparty-detail-profit" },
              ]}
            />
          ) : null}
          <Typography.Title level={5} className="ui-title-spaced">成单明细</Typography.Title>
          <DataTable
            columns={[
              { title: "订单", dataIndex: "order_no" },
              { title: "业务", render: (_value, row) => orderTypeLabel(row.order_type) },
              { title: "角色", render: (_value, row) => row.roles.map((role) => configurableLabel("COUNTERPARTY_TYPE", role)).join("、") || "-" },
              { title: "状态", render: (_value, row) => <StatusTag status={row.status} optionSet="ORDER_STATUS" /> },
              { title: "日期", dataIndex: "trade_date" },
              { title: "利润", render: (_value, row) => money(row.profit) },
            ]}
            rows={detailData.orders ?? []}
            page={1}
            pageSize={detailData.orders?.length || 1}
            total={detailData.orders?.length ?? 0}
            onPageChange={() => undefined}
            pagination={false}
            emptyText="暂无成单明细"
          />
          <Typography.Title level={5} className="ui-title-spaced">扩展字段</Typography.Title>
          {(() => {
            const items = buildFormExtraDisplay(detailData.extra_values, fieldDefs);
            if (items.length === 0) {
              return (
                <Typography.Paragraph type="secondary">
                  {fieldDefs.length === 0 ? "未配置扩展字段；在「设置 › 表单字段 › 合作方建档」新增自定义字段后，建档与详情会自动带出。" : "无扩展字段值"}
                </Typography.Paragraph>
              );
            }
            return (
              <Descriptions column={1} bordered size="small">
                {items.map((item) => (
                  <Descriptions.Item key={item.key} label={`${item.label}${item.status === "deleted" ? "（已删除）" : item.status === "inactive" ? "（已停用）" : ""}`}>
                    {formatExtraDisplayValue(item.value) || "未填写"}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            );
          })()}
          </>
        ) : null}
      </Drawer>
    </Card>
  );
}

