import { DatePicker, Form, Input, Modal, Table } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import { ordersApi, type Account, type AccountExecutionOrder } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { appMessage } from "../shared/ui/appFeedback";
import { ErrorBanner, PermissionButton, Select } from "../shared/ui";
import { CfgItem, CustomFieldSection, FieldConfigContext, useOrderFormConfig } from "../orders/ConfigurableField";

export type ActiveConsignment = {
  orderId: number;
  orderNo: string;
  platform: string;
  listedAt: string;
};

function minute(value: string | null | undefined) {
  if (!value) return "-";
  const normalized = value.replace("T", " ");
  return normalized.length >= 16 ? normalized.slice(0, 16) : `${normalized.slice(0, 10)} 00:00`;
}

export function consignmentRecords(orders: AccountExecutionOrder[]): ActiveConsignment[] {
  return orders
    .filter((order) => order.order_type === "DG" && order.status !== "CANCELLED")
    .map((order) => ({
      orderId: order.order_id,
      orderNo: order.order_no,
      platform: String(order.extra_values?.consignment_platform ?? order.account_platform ?? order.counterparties?.filter((party) => party.role === "PLATFORM").map((party) => party.display_name).join("、") ?? "-"),
      listedAt: minute(String(order.extra_values?.listed_at ?? order.created_at ?? order.trade_date)),
    }));
}

export function InventoryPlatformOffsaleModal(props: {
  account: Account | null;
  records: ActiveConsignment[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const open = Boolean(props.account);
  const { config } = useOrderFormConfig(open ? "INVOID" : undefined);

  useEffect(() => {
    if (!open) return;
    setError(null);
    form.setFieldsValue({ unlisted_at: dayjs().second(0).millisecond(0) });
  }, [form, open, props.account]);

  const submit = async (values: { order_id: number; unlisted_at?: Dayjs; reason: string; form_extra?: Record<string, unknown> }) => {
    const selected = props.records.find((record) => record.orderId === Number(values.order_id));
    if (!selected) return;
    setSubmitting(true);
    try {
      const unlistedAt = values.unlisted_at ?? dayjs();
      await ordersApi.cancel(selected.orderId, {
        reason: values.reason.trim(),
        form_extra_scope: "INVOID",
        form_extra: {
          ...values.form_extra,
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
    <Modal
      title="平台下架"
      open={open}
      destroyOnHidden
      onCancel={props.onClose}
      footer={
        <PermissionButton permission="order.update" danger type="primary" aria-label="确认平台下架" loading={submitting} onClick={() => form.submit()}>
          确认平台下架
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} />
      <p className="muted">平台下架只取消对应寄售平台的上架记录，不改变账号在 ERP 的库存状态。</p>
      <FieldConfigContext.Provider value={config}>
        <Form form={form} layout="horizontal" labelAlign="left" labelCol={{ flex: "108px" }} wrapperCol={{ flex: "auto" }} onFinish={submit}>
          <CfgItem name="order_id" label="寄售平台" rules={[{ required: true, message: "请选择寄售平台" }]}>
            <Select
              aria-label="寄售平台"
              placeholder="请选择要下架的平台"
              options={props.records.map((record) => ({ value: record.orderId, label: `${record.platform}（上架于 ${record.listedAt}）` }))}
            />
          </CfgItem>
          <CfgItem name="unlisted_at" label="下架时间" rules={[{ required: true, message: "请选择下架时间" }]}>
            <DatePicker aria-label="下架时间" showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" minuteStep={1} />
          </CfgItem>
          <CfgItem name="reason" label="下架原因" rules={[{ required: true, message: "请填写下架原因" }]}>
            <Input aria-label="下架原因" placeholder="请输入平台下架原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix="inv-platform-offsale" />
        </Form>
      </FieldConfigContext.Provider>
      <Table
        size="small"
        pagination={false}
        rowKey="orderId"
        dataSource={props.records}
        columns={[{ title: "上架平台", dataIndex: "platform" }, { title: "上架时间", dataIndex: "listedAt" }]}
        locale={{ emptyText: "暂无可下架的平台" }}
      />
    </Modal>
  );
}
