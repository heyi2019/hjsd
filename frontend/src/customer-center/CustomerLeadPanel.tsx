import { appMessage } from "../shared/ui/appFeedback";
/** 客户需求池：记录需求事实，支持转单或关闭，不自动生成订单（CUS-02）。 */
import { Card, Form, Input, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { leadsApi } from "../shared/api/customers.api";
import type { Customer, Lead } from "../shared/api/types/customers";
import { employeesApi } from "../shared/api/org.api";
import type { EmployeeOption } from "../shared/api/types/org";
import { normalizeError } from "../shared/api/client";
import { BusinessActionModal, BusinessRegistrationForm, CompactActions, DataTable, ErrorBanner, InlineError, MoneyInput, MoneyText, PermissionButton, Select, StatRow, StatusTag } from "../shared/ui";
import { moneyRules } from "../shared/lib/validators";
import { CfgItem, CustomFieldSection, FieldConfigContext, FieldConfigScope, FieldConfigStatus, useOrderFormConfig } from "../business/ConfigurableField";
import { configurableLabel } from "../shared/lib/optionSets";
import { useListViewColumns } from "../shared/lib/listColumns";
import { ResponsibleEmployeeSelect } from "../business/ResponsibleEmployeeSelect";
import { loadActiveCustomers } from "./loadActiveCustomers";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";

const REQUEST_TYPE_LABEL: Record<string, string> = { FIND_ACCOUNT: "找号", SELL_ACCOUNT: "卖号", SPECIFIC_SEARCH: "指定搜索" };

export function CustomerLeadPanel({ active = true, createdPeriod, createdPicker }: { active?: boolean; createdPeriod?: { from: string; to: string } | null; createdPicker?: ReactNode }) {
  const [rows, setRows] = useState<Lead[]>([]);
  const [summary, setSummary] = useState<{ total_count: number; open_count: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const requestRef = useRef(0);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const { config, ready: configReady, error: configError, retry: retryConfig } = useOrderFormConfig(createOpen ? "LEAD" : undefined);
  const [closeTarget, setCloseTarget] = useState<Lead | null>(null);
  const [convertTarget, setConvertTarget] = useState<Lead | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const write = useAsyncAction();
  const [customersLoading, setCustomersLoading] = useState(false);
  const [createForm] = Form.useForm();
  const [closeForm] = Form.useForm();
  const [convertForm] = Form.useForm();

  useEffect(() => {
    void Promise.resolve(employeesApi.list())
      .then((items) => setEmployees((items ?? []).filter((item) => item.is_active)))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const dates = createdPeriod ? { created_from: createdPeriod.from, created_to: createdPeriod.to } : {};
      const [leadPage, leadSummary] = await Promise.all([
        leadsApi.page({ ...dates, limit: pageSize, offset: (page - 1) * pageSize }),
        leadsApi.summary(dates),
      ]);
      if (request !== requestRef.current) return;
      setRows(leadPage.items);
      setSummary(leadSummary);
      setError(null);
    } catch (err) { if (request === requestRef.current) setError(normalizeError(err)); }
    finally { if (request === requestRef.current) setLoading(false); }
  }, [page, pageSize, createdPeriod?.from, createdPeriod?.to]);
  useEffect(() => { setPage(1); }, [createdPeriod?.from, createdPeriod?.to]);
  useEffect(() => {
    if (active) void load();
    return () => { requestRef.current += 1; };
  }, [active, load]);

  const openCreate = async () => {
    try {
      setError(null);
      write.clearError();
      setCustomersLoading(true);
      setCustomers(await loadActiveCustomers());
      setCreateOpen(true);
    } catch (err) { setError(normalizeError(err)); }
    finally { setCustomersLoading(false); }
  };

  const createLead = async (values: Record<string, unknown>) => {
    if (!configReady) return;
    await write.run(async () => {
      await leadsApi.create({ customer_id: Number(values.customer_id), request_type: values.request_type as string, budget: values.budget as string, target: values.target as string, note: values.note as string, extra_values: values.form_extra, operator_user_ids: values.operator_user_ids as number[] | undefined });
      appMessage.success("客户需求已创建"); setCreateOpen(false); createForm.resetFields(); await load();
    });
  };
  const closeLead = async (values: Record<string, unknown>) => {
    if (!closeTarget) return;
    await write.run(async () => {
      const operatorUserIds = values.operator_user_ids as number[] | undefined;
      if (operatorUserIds?.length) await leadsApi.close(closeTarget.id, values.reason as string, values.form_extra as Record<string, unknown> | undefined, operatorUserIds);
      else await leadsApi.close(closeTarget.id, values.reason as string, values.form_extra as Record<string, unknown> | undefined);
      appMessage.success("需求已关闭"); setCloseTarget(null); closeForm.resetFields(); await load();
    });
  };
  const convertLead = async (values: Record<string, unknown>) => {
    if (!convertTarget) return;
    await write.run(async () => {
      const operatorUserIds = values.operator_user_ids as number[] | undefined;
      const orderNo = String(values.order_id ?? "").trim();
      if (operatorUserIds?.length) await leadsApi.convert(convertTarget.id, orderNo, values.form_extra as Record<string, unknown> | undefined, operatorUserIds);
      else await leadsApi.convert(convertTarget.id, orderNo, values.form_extra as Record<string, unknown> | undefined);
      appMessage.success("需求已转单"); setConvertTarget(null); convertForm.resetFields(); await load();
    });
  };

  const { arrange: arrangeColumns } = useListViewColumns("LEAD");
  const columns: ColumnsType<Lead> = [
    { title: "需求编号", dataIndex: "lead_no" },
    { title: "客户", dataIndex: "customer_display_name", render: (v: string, row) => v || row.customer_id },
    { title: "需求类型", dataIndex: "request_type", render: (v: string) => configurableLabel("LEAD_TYPE", v, REQUEST_TYPE_LABEL) },
    { title: "预算", dataIndex: "budget", align: "right", render: (v: string | null) => v ? <MoneyText value={v} /> : "-" },
    { title: "目标", dataIndex: "target" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} optionSet="LEAD_STATUS" /> },
    { title: "创建操作人", dataIndex: "created_by", render: (v: string | null | undefined, row) => v || row.operation_operators?.find((item) => item.operation_key === "CREATE")?.operator_user_ids.join("、") || "-" },
    { title: "操作", key: "actions", render: (_v, row) => row.status === "OPEN" ? <Space size={2}><PermissionButton permission="customer.create" size="small" onClick={() => { write.clearError(); setConvertTarget(row); }}>转单</PermissionButton><PermissionButton permission="customer.update" size="small" onClick={() => { write.clearError(); setCloseTarget(row); }}>关闭</PermissionButton></Space> : null },
  ];

  return <section className="ui-stack">
    <Card
      className="glass customer-lead-shell"
      title="客户需求池"
      extra={<PermissionButton permission="customer.create" type="primary" loading={customersLoading} disabled={Boolean(error)} onClick={() => void openCreate()}>新增需求</PermissionButton>}
    >
      <ErrorBanner error={error} onRetry={() => void load()} />
      <StatRow items={[{ label: "需求总数", kind: "count", amount: loading || error ? null : String(summary?.total_count ?? 0) }, { label: "待跟进", kind: "count", amount: loading || error ? null : String(summary?.open_count ?? 0), tone: "warn" }]} />
      {createdPicker ? <Space wrap className="customer-list-filters--separated">{createdPicker}</Space> : null}
      <DataTable<Lead>
        columns={arrangeColumns(columns)}
        rows={error ? [] : rows}
        loading={loading || (summary === null && !error)}
        page={page}
        pageSize={pageSize}
        total={error ? 0 : summary?.total_count ?? 0}
        controlledPaging
        emptyText={error ? "客户需求数据不可用，请点击重新加载" : "暂无客户需求"}
        pagination={error ? false : undefined}
        onPageChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
      />
    </Card>
    <BusinessActionModal
      title="新增客户需求"
      fieldCount={5}
      open={createOpen}
      onCancel={() => { write.clearError(); setCreateOpen(false); }}
      footer={null}
    >
      <InlineError error={write.error} />
      <FieldConfigContext.Provider value={config}>
        <BusinessRegistrationForm scope="LEAD" form={createForm} onFinish={createLead}>
          <FieldConfigStatus scope="LEAD" ready={configReady} error={configError} retry={retryConfig} />
          <CfgItem name="customer_id" label="客户" rules={[{ required: true }]}><Select options={customers.map((customer) => ({ value: customer.id, label: `${customer.customer_no} · ${customer.display_name}` }))} /></CfgItem>
          <CfgItem name="request_type" label="需求类型" rules={[{ required: true }]}><Select /></CfgItem>
          <CfgItem name="budget" label="预算" rules={moneyRules("预算")}><MoneyInput /></CfgItem>
          <CfgItem name="target" label="需求目标" rules={[{ required: true }]}><Input.TextArea rows={3} /></CfgItem>
          <CfgItem name="note" label="备注"><Input.TextArea rows={2} /></CfgItem>
          <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
          <CustomFieldSection testIdSuffix="lead-create" />
          <PermissionButton permission="customer.create" type="primary" htmlType="submit" loading={write.pending} disabled={customers.length === 0 || !configReady}>创建需求</PermissionButton>
        </BusinessRegistrationForm>
      </FieldConfigContext.Provider>
    </BusinessActionModal>
    <BusinessActionModal size="compact" title="关闭客户需求" open={Boolean(closeTarget)} onCancel={() => { write.clearError(); setCloseTarget(null); }} footer={null}>
      <InlineError error={write.error} />
      <FieldConfigScope scope="LEADCLOSE" active={Boolean(closeTarget)}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="LEADCLOSE" form={closeForm} onFinish={closeLead}>
          <CfgItem name="reason" label="关闭原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></CfgItem>
          <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
          <CustomFieldSection testIdSuffix="lead-close" />
          <CompactActions>
            <PermissionButton permission="customer.update" type="primary" htmlType="submit" loading={write.pending}>确认关闭</PermissionButton>
          </CompactActions>
        </BusinessRegistrationForm>
      </FieldConfigScope>
    </BusinessActionModal>
    <BusinessActionModal size="compact" title="需求转单" open={Boolean(convertTarget)} onCancel={() => { write.clearError(); setConvertTarget(null); }} footer={null}>
      <InlineError error={write.error} />
      <FieldConfigScope scope="LEADCONVERT" active={Boolean(convertTarget)}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="LEADCONVERT" form={convertForm} onFinish={convertLead}>
          <CfgItem name="order_id" label="订单编号" rules={[{ required: true, whitespace: true, message: "请输入订单编号" }]}><Input placeholder="例如 HS0001" /></CfgItem>
          <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
          <CustomFieldSection testIdSuffix="lead-convert" />
          <CompactActions>
            <PermissionButton permission="customer.create" type="primary" htmlType="submit" loading={write.pending}>确认转单</PermissionButton>
          </CompactActions>
        </BusinessRegistrationForm>
      </FieldConfigScope>
    </BusinessActionModal>
  </section>;
}
