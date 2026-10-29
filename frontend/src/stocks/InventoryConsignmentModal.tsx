import { appMessage, appModal } from "../shared/ui/appFeedback";
/** 库存账号寄售：每次只登记一个中介平台及其实际上架时间。 */
import { DatePicker, Form, Table } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import {
  ordersApi,
  stocksApi,
  type Account,
  type AccountExecutionDetail,
} from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { useOptionSet } from "../shared/lib/optionSets";
import { BusinessActionModal, ErrorBanner, PermissionButton, Select } from "../shared/ui";
import { CfgItem, CustomFieldSection, FieldConfigContext, useOrderFormConfig } from "../orders/ConfigurableField";
import { InventoryAccountSummary } from "./InventoryAccountSummary";

type ListedPlatform = { key: number; platform: string; listedAt: string };

function dateTimeMinute(value: string): string {
  const normalized = value.replace("T", " ");
  return normalized.length >= 16 ? normalized.slice(0, 16) : `${normalized.slice(0, 10)} 00:00`;
}

function listedPlatforms(detail: AccountExecutionDetail): ListedPlatform[] {
  return detail.orders
    .filter((order) => order.order_type === "DG" && order.status !== "CANCELLED")
    .map((order) => ({
      key: order.order_id,
      platform: String(order.extra_values?.consignment_platform ?? order.counterparties
        ?.filter((party) => party.role === "PLATFORM")
        .map((party) => party.display_name)
        .join("、") ?? "-"),
      listedAt: dateTimeMinute(String(order.extra_values?.listed_at ?? order.created_at ?? order.trade_date)),
    }));
}

export function InventoryConsignmentModal(props: {
  account: Account | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [listed, setListed] = useState<ListedPlatform[]>([]);
  const [form] = Form.useForm();
  const open = Boolean(props.account);
  const { config } = useOrderFormConfig(open ? "CONSIGN" : undefined);
  const platforms = useOptionSet("INTERMEDIARY_PLATFORM") ?? [];

  const refreshListed = async (accountId: number) => {
    const detail = await stocksApi.executionDetail(accountId);
    setListed(detail.account.status === "VOID" ? [] : listedPlatforms(detail));
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    form.setFieldsValue({ listed_at: dayjs().second(0).millisecond(0) });
    if (props.account) void refreshListed(props.account.id).catch((cause) => setError(normalizeError(cause)));
  }, [form, open, props.account]);

  const submit = async (values: { platform?: string; listed_at?: Dayjs; form_extra?: Record<string, unknown> }) => {
    if (!props.account) return;
    const listedAt = values.listed_at ?? dayjs();
    if (!values.platform) return;
    setSubmitting(true);
    try {
      await ordersApi.create({
        order_type: "DG",
        trade_date: listedAt.format("YYYY-MM-DD"),
        account_id: props.account.id,
        note: `寄售平台：${values.platform}`,
        form_extra: {
          ...values.form_extra,
          consignment_platform: values.platform,
          listed_at: listedAt.format("YYYY-MM-DDTHH:mm"),
        },
        form_extra_scope: "CONSIGN",
      });
      appMessage.success(`${values.platform} 已上架，账号仍保持在库`);
      form.setFieldsValue({ platform: undefined, listed_at: dayjs().second(0).millisecond(0) });
      await refreshListed(props.account.id);
      await props.onCreated();
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BusinessActionModal
      title="登记寄售"
      open={open}
      destroyOnHidden
      onCancel={props.onClose}
      footer={
        <PermissionButton permission="order.create" type="primary" aria-label="确认上架" loading={submitting} onClick={() => form.submit()}>
          确认上架
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} />
      <InventoryAccountSummary account={props.account} />
      <FieldConfigContext.Provider value={config}>
        <Form
          form={form}
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
          onFinish={submit}
        >
          <CfgItem
            name="platform"
            label="寄售平台"
            rules={[{ required: true, message: "请选择寄售平台" }]}
          >
            {platforms.length ? (
              <Select aria-label="寄售平台" placeholder="请选择本次上架的平台" options={platforms} />
            ) : (
              <span className="muted">暂无可用寄售平台，请先在中介业务配置中维护经手平台</span>
            )}
          </CfgItem>
          <CfgItem name="listed_at" label="上架时间" rules={[{ required: true, message: "请选择上架时间" }]}>
            <DatePicker aria-label="上架时间" showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" minuteStep={1} />
          </CfgItem>
          <p className="muted">每次确认只登记一个平台；可继续选择下一个平台并填写其上架时间。</p>
          <section aria-label="已上架记录">
            <h4>已上架记录</h4>
            <Table<ListedPlatform>
              size="small"
              pagination={false}
              rowKey="key"
              dataSource={listed}
              columns={[
                { title: "上架平台", dataIndex: "platform" },
                { title: "上架时间", dataIndex: "listedAt", width: 180 },
              ]}
              locale={{ emptyText: "暂无上架记录" }}
            />
          </section>
          <CustomFieldSection section="OPERATION" testIdSuffix="inventory-consignment-operation" />
          <CustomFieldSection testIdSuffix="inventory-consignment" />
        </Form>
      </FieldConfigContext.Provider>
    </BusinessActionModal>
  );
}
