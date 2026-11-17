import { DatePicker, Form, Input } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import { employeesApi } from "../../shared/api/org.api";
import type { AccountExecutionOrder } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import type { EmployeeOption } from "../../shared/api/types/org";
import { normalizeError } from "../../shared/api/client";
import { appMessage } from "../../shared/ui/appFeedback";
import { BusinessActionModal, CompactActions, BusinessRegistrationForm, DataTable, ErrorBanner, PermissionButton, Select } from "../../shared/ui";
import { CfgItem, CustomFieldSection, FieldConfigContext, useOrderFormConfig } from "../ConfigurableField";
import { ResponsibleEmployeeSelect } from "../ResponsibleEmployeeSelect";
import { consignmentListings, type ConsignmentListing } from "./consignment-logic";
import { formatDateTimeMinute } from "../../shared/lib/format";

export type ActiveConsignment = ConsignmentListing;

type SystemConsignment = {
  id: "SYSTEM";
  orderId: "SYSTEM";
  orderNo: "ERP";
  platform: "本系统";
  price: null;
  listedAt: string;
};
type DisplayConsignment = ActiveConsignment | SystemConsignment;

export function consignmentRecords(orders: AccountExecutionOrder[]): ActiveConsignment[] {
  return consignmentListings(orders);
}

export function OrderPlatformOffsaleModal(props: {
  account: Account | null;
  records: ActiveConsignment[];
  onClose: () => void;
  onSystemOffsale: (payload: { reason: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) => void | Promise<void>;
  onChanged: () => void | Promise<void>;
}) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const open = Boolean(props.account);
  const canSystemOffsale = props.account?.inventory_type === "CONSIGNMENT";
  const systemRecord: SystemConsignment | null = canSystemOffsale && props.account
    ? {
      id: "SYSTEM",
      orderId: "SYSTEM",
      orderNo: "ERP",
      platform: "本系统",
      price: null,
      listedAt: formatDateTimeMinute(String(props.account.created_at ?? props.account.buy_date ?? "")),
    }
    : null;
  const displayRecords: DisplayConsignment[] = systemRecord ? [...props.records, systemRecord] : props.records;
  const [selectedMode, setSelectedMode] = useState<"PLATFORM" | "SYSTEM">("PLATFORM");
  const { config } = useOrderFormConfig(open ? "INVOID" : undefined);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSelectedMode(props.records.length ? "PLATFORM" : canSystemOffsale ? "SYSTEM" : "PLATFORM");
    form.setFieldsValue({ unlisted_at: dayjs().second(0).millisecond(0) });
    void employeesApi.list().then((items) => setEmployees(items.filter((item) => item.is_active))).catch((cause) => setError(normalizeError(cause)));
  }, [canSystemOffsale, form, open, props.account, props.records.length]);

  const submit = async (values: { listing_id: string; unlisted_at?: Dayjs; reason: string; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) => {
    if (values.listing_id === "SYSTEM") {
      setSubmitting(true);
      try {
        await props.onSystemOffsale({ reason: values.reason.trim(), operator_user_ids: values.operator_user_ids, form_extra: values.form_extra });
        form.resetFields();
      } catch (cause) {
        setError(normalizeError(cause));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const selected = props.records.find((record) => record.id === values.listing_id);
    if (!selected) return;
    setSubmitting(true);
    try {
      const unlistedAt = values.unlisted_at ?? dayjs();
      await ordersApi.postEvent(selected.orderId, {
        event_type: "OPERATE",
        operation_type: "UNLIST",
        occurred_on: unlistedAt.format("YYYY-MM-DD"),
        operator_user_ids: values.operator_user_ids,
        note: `寄售下架：${selected.platform}`,
        form_extra_scope: "INVOID",
        form_extra: {
          ...values.form_extra,
          ...(selected.eventId == null ? {} : { consignment_event_id: selected.eventId }),
          consignment_platforms: [selected.platform],
          platform_unlisted_at: unlistedAt.format("YYYY-MM-DDTHH:mm"),
          platform_unlist_scope: "PLATFORM",
        },
      });
      appMessage.success(`${selected.platform} 已下架，账号仍保留在 ERP 库存`);
      form.resetFields();
      await props.onChanged();
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BusinessActionModal size="compact"
      title={selectedMode === "SYSTEM" ? "出库" : "下架"}
      open={open}
      destroyOnHidden
      onCancel={props.onClose}
      footer={
        <CompactActions onCancel={props.onClose} divider={false}>
          <PermissionButton permission="order.update" danger type="primary" aria-label={selectedMode === "SYSTEM" ? "确认出库" : "确认下架"} loading={submitting} onClick={() => form.submit()}>
            {selectedMode === "SYSTEM" ? "确认出库" : "确认下架"}
          </PermissionButton>
        </CompactActions>
      }
    >
      <ErrorBanner error={error} />
      <p className="muted">选择寄售平台时只取消对应平台的上架记录；选择本系统时按 ERP 出库处理，账号退出库存中心。</p>
      <FieldConfigContext.Provider value={config}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INVOID" form={form} onFinish={submit}>
          <CfgItem name="listing_id" label="下架平台" rules={[{ required: true, message: "请选择下架平台" }]}>
            <Select
              aria-label="下架平台"
              placeholder="请选择要下架的平台"
              onChange={(value) => setSelectedMode(value === "SYSTEM" ? "SYSTEM" : "PLATFORM")}
              options={displayRecords.map((record) => ({ value: record.id, label: `${record.platform}（上架于 ${record.listedAt}）` }))}
            />
          </CfgItem>
          <CfgItem name="unlisted_at" label="下架时间" rules={[{ required: true, message: "请选择下架时间" }]}>
            <DatePicker aria-label="下架时间" showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" minuteStep={1} />
          </CfgItem>
          <CfgItem name="reason" label="下架原因" rules={[{ required: true, message: "请填写下架原因" }]}>
            <Input aria-label="下架原因" placeholder="请输入平台下架原因" />
          </CfgItem>
          <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
          <CustomFieldSection testIdSuffix="inv-platform-offsale" />
        </BusinessRegistrationForm>
      </FieldConfigContext.Provider>
      <DataTable
        size="small"
        pagination={false}
        rowKey="id"
        rows={displayRecords}
        page={1}
        pageSize={10}
        total={displayRecords.length}
        onPageChange={() => undefined}
        emptyText="暂无可下架的平台"
        columns={[{ title: "上架平台", dataIndex: "platform" }, { title: "上架时间", dataIndex: "listedAt" }]}
      />
    </BusinessActionModal>
  );
}
