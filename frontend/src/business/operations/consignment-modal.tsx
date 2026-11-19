import { appMessage } from "../../shared/ui/appFeedback";
/** 库存账号寄售：每次只登记一个中介平台及其实际上架时间。 */
import { DatePicker, Form, InputNumber } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useRef, useState } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import { employeesApi } from "../../shared/api/org.api";
import type { Account } from "../../shared/api/types/accounts";
import type { EmployeeOption } from "../../shared/api/types/org";
import { normalizeError } from "../../shared/api/client";
import { useOptionSet } from "../../shared/lib/optionSets";
import { BusinessActionModal, CompactActions, BusinessRegistrationForm, DataTable, ErrorBanner, MoneyText, PermissionButton, Select } from "../../shared/ui";
import { CfgItem, CustomFieldSection, FieldConfigContext, FieldConfigStatus, useOrderFormConfig } from "../ConfigurableField";
import { ResponsibleEmployeeSelect } from "../ResponsibleEmployeeSelect";
import { InventoryAccountSummary } from "../stocks/InventoryAccountSummary";
import { activeConsignmentListings } from "./consignment-logic";
import "./consignment-modal.css";

type ListedPlatform = { key: number; platform: string; price: number | string | null; listedAt: string };

export function OrderConsignmentModal(props: {
  account: Account | null;
  orderId?: number | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [listed, setListed] = useState<ListedPlatform[]>([]);
  const [listingReady, setListingReady] = useState(false);
  const [listingLoading, setListingLoading] = useState(false);
  const [listingError, setListingError] = useState<{ message: string; code?: string } | null>(null);
  const requestGeneration = useRef(0);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [sourceOrderId, setSourceOrderId] = useState<number | null>(props.orderId ?? props.account?.source_order_id ?? null);
  const [form] = Form.useForm();
  const open = Boolean(props.account);
  const { config, ready: configReady, error: configError, retry: retryConfig } = useOrderFormConfig(open ? "CONSIGN" : undefined);
  const platforms = useOptionSet("INTERMEDIARY_PLATFORM") ?? [];
  const availablePlatforms = platforms.filter((option) => !listed.some((item) => item.platform === option.value));

  const refreshListed = async (orderId: number, generation: number) => {
    const detail = await ordersApi.executionDetail(orderId);
    if (generation !== requestGeneration.current) return;
    const sourceOrder = detail.orders.find((order) => order.order_id === orderId);
    setSourceOrderId(sourceOrder?.order_id ?? null);
    const current = detail.account.status === "VOID" || !sourceOrder ? [] : activeConsignmentListings(sourceOrder).map((item) => ({
      key: item.eventId ?? item.orderId,
      platform: item.platform,
      price: item.price,
      listedAt: item.listedAt,
    }));
    setListed(current);
    if (current.some((item) => item.platform === form.getFieldValue("platform"))) form.setFieldValue("platform", undefined);
    setListingReady(Boolean(sourceOrder) && detail.account.status !== "VOID");
  };

  const reloadListed = async (orderId: number): Promise<boolean> => {
    const generation = ++requestGeneration.current;
    setListingLoading(true);
    try {
      await refreshListed(orderId, generation);
      if (generation === requestGeneration.current) setListingError(null);
      return true;
    } catch (cause) {
      if (generation === requestGeneration.current) setListingError(normalizeError(cause));
      return false;
    } finally {
      if (generation === requestGeneration.current) setListingLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    setListingError(null);
    setListed([]);
    setListingReady(false);
    setSourceOrderId(props.orderId ?? props.account?.source_order_id ?? null);
    form.setFieldsValue({ listed_at: dayjs().second(0).millisecond(0) });
    void employeesApi.list().then((items) => setEmployees(items.filter((item) => item.is_active))).catch((cause) => setError(normalizeError(cause)));
    const orderId = props.orderId ?? props.account?.source_order_id;
    if (orderId != null) void reloadListed(orderId);
    return () => { requestGeneration.current += 1; };
  }, [form, open, props.account, props.orderId]);

  const submit = async (values: { platform?: string; consignment_price?: number | null; listed_at?: Dayjs; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) => {
    if (!props.account || !configReady) return;
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
        operator_user_ids: values.operator_user_ids,
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
      // 上架已成功；列表刷新与通知父页面并行，避免详情慢时弹窗一直停在确认状态。
      // 刷新完成前暂不可再次选平台，防止重复上架。
      setListingReady(false);
      const [listingRefreshed] = await Promise.all([
        reloadListed(sourceOrderId),
        Promise.resolve().then(() => props.onCreated()),
      ]);
      if (!listingRefreshed) appMessage.warning("已上架，但上架记录刷新失败，请重新加载");
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
          <PermissionButton permission="order.create" type="primary" aria-label="确认上架" loading={submitting} disabled={!configReady} onClick={() => form.submit()}>
            确认上架
          </PermissionButton>
        </CompactActions>
      }
    >
      <ErrorBanner error={error} />
      <ErrorBanner error={listingError} onRetry={sourceOrderId != null ? () => void reloadListed(sourceOrderId) : undefined} retrying={listingLoading} />
      <InventoryAccountSummary account={props.account} />
      <FieldConfigContext.Provider value={config}>
        <BusinessRegistrationForm
          className="consignment-compact-form"
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
          scope="CONSIGN"
          form={form}
          onFinish={submit}
        >
          <FieldConfigStatus scope="CONSIGN" ready={configReady} error={configError} retry={retryConfig} />
          <CfgItem
            name="platform"
            label="寄售平台"
            rules={[{ required: true, message: "请选择寄售平台" }]}
          >
            {platforms.length ? (
              <Select
                aria-label="寄售平台"
                disabled={!listingReady}
                placeholder="请选择本次上架的平台"
                options={availablePlatforms}
                notFoundContent="当前平台均已上架"
                popupMatchSelectWidth
                popupClassName="consignment-platform-pop"
              />
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
              placeholder="本次挂牌价，选填"
            />
          </CfgItem>
          <CfgItem name="listed_at" label="上架时间" rules={[{ required: true, message: "请选择上架时间" }]}>
            <DatePicker aria-label="上架时间" showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" minuteStep={1} />
          </CfgItem>
          <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={employees} />
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
              scroll={listed.length > 5 ? { x: "max-content", y: 180 } : { x: "max-content" }}
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
