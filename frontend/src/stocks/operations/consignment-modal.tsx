import { appMessage } from "../../shared/ui/appFeedback";
/** 库存账号寄售：每次只登记一个中介平台及其实际上架时间。 */
import { DatePicker, Form, InputNumber } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import { stocksApi } from "../../shared/api/stocks.api";
import type { Account } from "../../shared/api/types/accounts";
import { normalizeError } from "../../shared/api/client";
import { useOptionSet } from "../../shared/lib/optionSets";
import { BusinessActionModal, CompactActions, BusinessRegistrationForm, DataTable, ErrorBanner, MoneyText, PermissionButton, Select } from "../../shared/ui";
import { CfgItem, CustomFieldSection, FieldConfigContext, useOrderFormConfig } from "../../orders/ConfigurableField";
import { InventoryAccountSummary } from "../InventoryAccountSummary";
import { activeConsignmentListings } from "./consignment-logic";
import "./consignment-modal.css";

type ListedPlatform = { key: number; platform: string; price: number | string | null; listedAt: string };

export function InventoryConsignmentModal(props: {
  account: Account | null;
  orderId?: number | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [listed, setListed] = useState<ListedPlatform[]>([]);
  const [sourceOrderId, setSourceOrderId] = useState<number | null>(props.orderId ?? props.account?.source_order_id ?? null);
  const [form] = Form.useForm();
  const open = Boolean(props.account);
  const { config } = useOrderFormConfig(open ? "CONSIGN" : undefined);
  const platforms = useOptionSet("INTERMEDIARY_PLATFORM") ?? [];

  const refreshListed = async (accountId: number) => {
    const detail = await stocksApi.executionDetail(accountId);
    const sourceOrder = detail.orders.find((order) => order.order_id === (props.orderId ?? props.account?.source_order_id))
      ?? detail.orders.find((order) => order.order_type !== "DG")
      ?? detail.orders[0];
    setSourceOrderId(sourceOrder?.order_id ?? null);
    setListed(detail.account.status === "VOID" ? [] : detail.orders.flatMap((order) => activeConsignmentListings(order).map((item) => ({
      key: item.eventId ?? item.orderId,
      platform: item.platform,
      price: item.price,
      listedAt: item.listedAt,
    }))));
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSourceOrderId(props.orderId ?? props.account?.source_order_id ?? null);
    form.setFieldsValue({ listed_at: dayjs().second(0).millisecond(0) });
    if (props.account) void refreshListed(props.account.id).catch((cause) => setError(normalizeError(cause)));
  }, [form, open, props.account]);

  const submit = async (values: { platform?: string; consignment_price?: number | null; listed_at?: Dayjs; form_extra?: Record<string, unknown> }) => {
    if (!props.account) return;
    const listedAt = values.listed_at ?? dayjs();
    if (!values.platform) return;
    if (!sourceOrderId) {
      setError({ message: "当前账号没有可关联的来源订单，无法登记寄售" });
      return;
    }
    const price = typeof values.consignment_price === "number" ? values.consignment_price : undefined;
    setSubmitting(true);
    try {
      await ordersApi.postEvent(sourceOrderId, {
        event_type: "OPERATE",
        operation_type: "CONSIGNMENT",
        occurred_on: listedAt.format("YYYY-MM-DD"),
        note: `寄售上架：${values.platform}`,
        form_extra_scope: "CONSIGN",
        form_extra: {
          ...values.form_extra,
          consignment_platforms: [values.platform],
          ...(price === undefined ? {} : { consignment_price: price }),
          listed_at: listedAt.format("YYYY-MM-DDTHH:mm"),
        },
      });
      appMessage.success(`${values.platform} 已上架，账号仍保持在库`);
      form.setFieldsValue({ platform: undefined, consignment_price: null, listed_at: dayjs().second(0).millisecond(0) });
      await refreshListed(props.account.id);
      await props.onCreated();
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BusinessActionModal size="compact"
      title="登记寄售"
      open={open}
      destroyOnHidden
      onCancel={props.onClose}
      footer={
        <CompactActions onCancel={props.onClose} divider={false}>
          <PermissionButton permission="order.create" type="primary" aria-label="确认上架" loading={submitting} onClick={() => form.submit()}>
            确认上架
          </PermissionButton>
        </CompactActions>
      }
    >
      <ErrorBanner error={error} />
      <InventoryAccountSummary account={props.account} />
      <FieldConfigContext.Provider value={config}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
          scope="CONSIGN"
          form={form}
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
          <CfgItem name="consignment_price" label="寄售价格">
            <InputNumber
              aria-label="寄售价格"
              min={0}
              precision={2}
              prefix="¥"
              className="ui-control-width-180"
              placeholder="本次挂牌价，选填"
            />
          </CfgItem>
          <CfgItem name="listed_at" label="上架时间" rules={[{ required: true, message: "请选择上架时间" }]}>
            <DatePicker aria-label="上架时间" showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" minuteStep={1} />
          </CfgItem>
          <p className="muted">每次确认只登记一个平台；可继续选择下一个平台并填写其上架时间。</p>
          <section aria-label="已上架记录">
            <h4>已上架记录</h4>
            <DataTable<ListedPlatform>
              className="inventory-consignment-records-table"
              size="small"
              pagination={false}
              rowKey="key"
              rows={listed}
              page={1}
              pageSize={10}
              total={listed.length}
              onPageChange={() => undefined}
              emptyText="暂无上架记录"
              columns={[
                { title: "上架平台", dataIndex: "platform" },
                { title: "寄售价格", dataIndex: "price", width: 120, align: "right", render: (value: number | string | null) => value == null ? "-" : <MoneyText value={value} tone="plain" /> },
                { title: "上架时间", dataIndex: "listedAt", width: 180 },
              ]}
            />
          </section>
          <CustomFieldSection section="OPERATION" testIdSuffix="inventory-consignment-operation" />
          <CustomFieldSection testIdSuffix="inventory-consignment" />
        </BusinessRegistrationForm>
      </FieldConfigContext.Provider>
    </BusinessActionModal>
  );
}
