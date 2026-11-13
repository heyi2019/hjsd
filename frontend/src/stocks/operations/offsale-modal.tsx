import { DatePicker, Form, Input } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import type { AccountExecutionOrder } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import { normalizeError } from "../../shared/api/client";
import { appMessage } from "../../shared/ui/appFeedback";
import { BusinessActionModal, CompactActions, BusinessRegistrationForm, DataTable, ErrorBanner, PermissionButton, Select } from "../../shared/ui";
import { CfgItem, CustomFieldSection, FieldConfigContext, useOrderFormConfig } from "../../orders/ConfigurableField";
import { consignmentListings, type ConsignmentListing } from "./consignment-logic";
import { formatDateTimeMinute } from "../../shared/lib/format";

export type ActiveConsignment = ConsignmentListing;

type DisplayConsignment = Omit<ActiveConsignment, "orderId"> & { orderId: number | "SYSTEM" };

export function consignmentRecords(orders: AccountExecutionOrder[]): ActiveConsignment[] {
  return consignmentListings(orders);
}

export function InventoryPlatformOffsaleModal(props: {
  account: Account | null;
  records: ActiveConsignment[];
  onClose: () => void;
  onSystemOffsale: (payload: { reason: string; form_extra?: Record<string, unknown> }) => void | Promise<void>;
  onChanged: () => void | Promise<void>;
}) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const open = Boolean(props.account);
  const canSystemOffsale = props.account?.inventory_type === "CONSIGNMENT";
  const systemRecord: DisplayConsignment | null = canSystemOffsale && props.account
    ? {
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
  }, [canSystemOffsale, form, open, props.account, props.records.length]);

  const submit = async (values: { order_id: number | "SYSTEM"; unlisted_at?: Dayjs; reason: string; form_extra?: Record<string, unknown> }) => {
    if (values.order_id === "SYSTEM") {
      setSubmitting(true);
      try {
        await props.onSystemOffsale({ reason: values.reason.trim(), form_extra: values.form_extra });
        form.resetFields();
      } catch (cause) {
        setError(normalizeError(cause));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const selected = props.records.find((record) => record.orderId === Number(values.order_id));
    if (!selected) return;
    setSubmitting(true);
    try {
      const unlistedAt = values.unlisted_at ?? dayjs();
      await ordersApi.postEvent(selected.orderId, {
        event_type: "OPERATE",
        operation_type: "UNLIST",
        occurred_on: unlistedAt.format("YYYY-MM-DD"),
        note: `寄售下架：${selected.platform}`,
        form_extra_scope: "INVOID",
        form_extra: {
          ...values.form_extra,
          ...(selected.eventId == null ? {} : { consignment_event_id: selected.eventId }),
          consignment_platform: selected.platform,
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
          <CfgItem name="order_id" label="下架平台" rules={[{ required: true, message: "请选择下架平台" }]}>
            <Select
              aria-label="下架平台"
              placeholder="请选择要下架的平台"
              onChange={(value) => setSelectedMode(value === "SYSTEM" ? "SYSTEM" : "PLATFORM")}
              options={displayRecords.map((record) => ({ value: record.orderId, label: `${record.platform}（上架于 ${record.listedAt}）` }))}
            />
          </CfgItem>
          <CfgItem name="unlisted_at" label="下架时间" rules={[{ required: true, message: "请选择下架时间" }]}>
            <DatePicker aria-label="下架时间" showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" minuteStep={1} />
          </CfgItem>
          <CfgItem name="reason" label="下架原因" rules={[{ required: true, message: "请填写下架原因" }]}>
            <Input aria-label="下架原因" placeholder="请输入平台下架原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix="inv-platform-offsale" />
        </BusinessRegistrationForm>
      </FieldConfigContext.Provider>
      <DataTable
        size="small"
        pagination={false}
        rowKey="orderId"
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
