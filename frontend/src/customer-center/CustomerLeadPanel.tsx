import { appMessage } from "../shared/ui/appFeedback";
/** 客户需求池：记录需求事实，支持转单或关闭，不自动生成订单（CUS-02）。 */
import { Card, Form, Input, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useState } from "react";
import { customersApi, leadsApi } from "../shared/api/customers.api";
import type { Customer, Lead } from "../shared/api/types/customers";
import { normalizeError } from "../shared/api/client";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import { BusinessActionModal, BusinessRegistrationForm, CompactActions, DataTable, ErrorBanner, MoneyInput, MoneyText, PermissionButton, Select, StatRow, StatusTag } from "../shared/ui";
import { moneyRules } from "../shared/lib/validators";
import { CfgItem, CustomFieldSection, FieldConfigContext, FieldConfigScope, useOrderFormConfig } from "../orders/ConfigurableField";
import { configurableLabel } from "../shared/lib/optionSets";

const REQUEST_TYPE_LABEL: Record<string, string> = { FIND_ACCOUNT: "找号", SELL_ACCOUNT: "卖号", SPECIFIC_SEARCH: "指定搜索" };

export function CustomerLeadPanel({ active = true }: { active?: boolean }) {
  const [rows, setRows] = useState<Lead[]>([]);
  const [summary, setSummary] = useState<{ total_count: number; open_count: number } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const { config } = useOrderFormConfig(createOpen ? "LEAD" : undefined);
  const [closeTarget, setCloseTarget] = useState<Lead | null>(null);
  const [convertTarget, setConvertTarget] = useState<Lead | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [acting, setActing] = useState(false);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [createForm] = Form.useForm();
  const [closeForm] = Form.useForm();
  const [convertForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const [leadPage, leadSummary] = await Promise.all([
        leadsApi.page({ limit: pageSize, offset: (page - 1) * pageSize }),
        leadsApi.summary(),
      ]);
      setRows(leadPage.items);
      setSummary(leadSummary);
      setError(null);
    } catch (err) { setError(normalizeError(err)); }
  }, [page, pageSize]);
  useReloadOnActive(active, load);

  const openCreate = async () => {
    try {
      setError(null);
      setCustomersLoading(true);
      if (customers.length === 0) {
        const customerPage = await customersApi.page({ status: "ACTIVE", limit: 500, offset: 0 });
        setCustomers(customerPage.items);
      }
      setCreateOpen(true);
    } catch (err) { setError(normalizeError(err)); }
    finally { setCustomersLoading(false); }
  };

  const createLead = async (values: Record<string, unknown>) => {
    try {
      setError(null);
      setActing(true);
      await leadsApi.create({ customer_id: Number(values.customer_id), request_type: values.request_type as string, budget: values.budget as string, target: values.target as string, note: values.note as string, extra_values: values.form_extra });
      appMessage.success("客户需求已创建"); setCreateOpen(false); createForm.resetFields(); await load();
    } catch (err) { setError(normalizeError(err)); }
    finally { setActing(false); }
  };
  const closeLead = async (values: Record<string, unknown>) => {
    if (!closeTarget) return;
    try {
      setError(null);
      setActing(true);
      await leadsApi.close(closeTarget.id, values.reason as string, values.form_extra as Record<string, unknown> | undefined); appMessage.success("需求已关闭"); setCloseTarget(null); closeForm.resetFields(); await load();
    }
    catch (err) { setError(normalizeError(err)); }
    finally { setActing(false); }
  };
  const convertLead = async (values: Record<string, unknown>) => {
    if (!convertTarget) return;
    try {
      setError(null);
      setActing(true);
      await leadsApi.convert(convertTarget.id, Number(values.order_id), values.form_extra as Record<string, unknown> | undefined); appMessage.success("需求已转单"); setConvertTarget(null); convertForm.resetFields(); await load();
    }
    catch (err) { setError(normalizeError(err)); }
    finally { setActing(false); }
  };

  const columns: ColumnsType<Lead> = [
    { title: "需求编号", dataIndex: "lead_no" },
    { title: "客户", dataIndex: "customer_display_name", render: (v: string, row) => v || row.customer_id },
    { title: "需求类型", dataIndex: "request_type", render: (v: string) => configurableLabel("LEAD_TYPE", v, REQUEST_TYPE_LABEL) },
    { title: "预算", dataIndex: "budget", align: "right", render: (v: string | null) => v ? <MoneyText value={v} /> : "-" },
    { title: "目标", dataIndex: "target" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} optionSet="LEAD_STATUS" /> },
    { title: "操作", render: (_v, row) => row.status === "OPEN" ? <Space size={2}><PermissionButton permission="customer.create" size="small" onClick={() => setConvertTarget(row)}>转单</PermissionButton><PermissionButton permission="customer.update" size="small" onClick={() => setCloseTarget(row)}>关闭</PermissionButton></Space> : null },
  ];

  return <section className="ui-stack">
    <ErrorBanner error={error} onRetry={() => void load()} />
    <StatRow items={[{ label: "需求总数", kind: "count", amount: error ? null : String(summary?.total_count ?? 0) }, { label: "待跟进", kind: "count", amount: error ? null : String(summary?.open_count ?? 0), tone: "warn" }]} />
    <Card className="glass" title="客户需求池" extra={<PermissionButton permission="customer.create" type="primary" loading={customersLoading} disabled={Boolean(error)} onClick={() => void openCreate()}>新增需求</PermissionButton>}>
      <DataTable<Lead>
        columns={columns}
        rows={rows}
        loading={summary === null && !error}
        page={page}
        pageSize={pageSize}
        total={summary?.total_count ?? 0}
        emptyText="暂无客户需求"
        pagination={error ? false : undefined}
        onPageChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
      />
    </Card>
    <BusinessActionModal
      title="新增客户需求"
      fieldCount={5}
      open={createOpen}
      onCancel={() => setCreateOpen(false)}
      footer={null}
    >
      <FieldConfigContext.Provider value={config}>
        <BusinessRegistrationForm scope="LEAD" form={createForm} onFinish={createLead}>
          <CfgItem name="customer_id" label="客户" rules={[{ required: true }]}><Select options={customers.map((customer) => ({ value: customer.id, label: `${customer.customer_no} · ${customer.display_name}` }))} /></CfgItem>
          <CfgItem name="request_type" label="需求类型" rules={[{ required: true }]}><Select /></CfgItem>
          <CfgItem name="budget" label="预算" rules={moneyRules("预算")}><MoneyInput /></CfgItem>
          <CfgItem name="target" label="需求目标" rules={[{ required: true }]}><Input.TextArea rows={3} /></CfgItem>
          <CfgItem name="note" label="备注"><Input.TextArea rows={2} /></CfgItem>
          <CustomFieldSection testIdSuffix="lead-create" />
          <PermissionButton permission="customer.create" type="primary" htmlType="submit" loading={acting} disabled={customers.length === 0}>创建需求</PermissionButton>
        </BusinessRegistrationForm>
      </FieldConfigContext.Provider>
    </BusinessActionModal>
    <BusinessActionModal size="compact" title="关闭客户需求" open={Boolean(closeTarget)} onCancel={() => setCloseTarget(null)} footer={null}>
      <FieldConfigScope scope="LEADCLOSE" active={Boolean(closeTarget)}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="LEADCLOSE" form={closeForm} onFinish={closeLead}>
          <CfgItem name="reason" label="关闭原因" rules={[{ required: true }]}><Input.TextArea rows={3} /></CfgItem>
          <CustomFieldSection testIdSuffix="lead-close" />
          <CompactActions>
            <PermissionButton permission="customer.update" type="primary" htmlType="submit" loading={acting}>确认关闭</PermissionButton>
          </CompactActions>
        </BusinessRegistrationForm>
      </FieldConfigScope>
    </BusinessActionModal>
    <BusinessActionModal size="compact" title="需求转单" open={Boolean(convertTarget)} onCancel={() => setConvertTarget(null)} footer={null}>
      <FieldConfigScope scope="LEADCONVERT" active={Boolean(convertTarget)}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="LEADCONVERT" form={convertForm} onFinish={convertLead}>
          <CfgItem name="order_id" label="订单 ID" rules={[{ required: true }]}><Input /></CfgItem>
          <CustomFieldSection testIdSuffix="lead-convert" />
          <CompactActions>
            <PermissionButton permission="customer.create" type="primary" htmlType="submit" loading={acting}>确认转单</PermissionButton>
          </CompactActions>
        </BusinessRegistrationForm>
      </FieldConfigScope>
    </BusinessActionModal>
  </section>;
}
