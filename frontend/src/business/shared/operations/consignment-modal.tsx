import { appMessage } from "../../../shared/ui/appFeedback";
/** 库存账号寄售：每次只登记一个中介平台及其实际上架时间。 */
import { DatePicker, Form, InputNumber } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useState } from "react";
import { ordersApi } from "../../../shared/api/orders.api";
import { employeesApi } from "../../../shared/api/org.api";
import type { Account } from "../../../shared/api/types/accounts";
import type { EmployeeOption } from "../../../shared/api/types/org";
import { normalizeError } from "../../../shared/api/client";
import { useOptionSetResource } from "../../../shared/lib/optionSets";
import { BusinessActionModal, CompactActions, BusinessRegistrationForm, DataTable, ErrorBanner, MoneyText, PermissionButton, Select } from "../../../shared/ui";
import { CfgItem, CustomFieldSections, FieldConfigContext, FieldConfigStatus, SectionLabelsContext, useOrderFormConfig, useOrderFormSectionLabels } from "../../../shared/forms/ConfigurableField";
import { ResponsibleEmployeeSelect } from "../../../shared/forms/ResponsibleEmployeeSelect";
import { InventoryAccountSummary } from "../inventory/InventoryAccountSummary";
import { useLatestRequest, useRequestSession } from "../../../shared/hooks/useLatestRequest";
import { useAsyncAction } from "../../../shared/hooks/useAsyncAction";
import { formExtraOrUndefined } from "../../../shared/lib/formExtra";
import { activeConsignmentListings, availableConsignmentPlatforms } from "./consignment-logic";
import "./consignment-modal.css";
import "../../../shared/ui/AdaptiveFormGrid/MoneyInput.css";

type ListedPlatform = { key: number; platform: string; price: number | string | null; listedAt: string };

export function OrderConsignmentModal(props: {
  account: Account | null;
  orderId?: number | null;
  onClose: () => void;
  onCreated: (account: Account, orderId: number) => void | Promise<void>;
}) {
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const write = useAsyncAction();
  const submitting = write.pending;
  const [listed, setListed] = useState<ListedPlatform[]>([]);
  const [listingReady, setListingReady] = useState(false);
  const [listingLoading, setListingLoading] = useState(false);
  const [listingError, setListingError] = useState<{ message: string; code?: string } | null>(null);
  const requestGeneration = useLatestRequest();
  const employeesRequest = useLatestRequest();
  const session = useRequestSession(props.account);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [sourceOrderId, setSourceOrderId] = useState<number | null>(props.orderId ?? props.account?.source_order_id ?? null);
  const [form] = Form.useForm();
  const open = Boolean(props.account);
  const { config, ready: configReady, error: configError, retry: retryConfig } = useOrderFormConfig(open ? "CONSIGN" : undefined);
  const { labels } = useOrderFormSectionLabels(open ? "CONSIGN" : undefined);
  const platformResource = useOptionSetResource("INTERMEDIARY_PLATFORM", open);
  const platforms = platformResource.options ?? [];
  const availablePlatforms = availableConsignmentPlatforms(platforms, listed);

  const refreshListed = async (orderId: number, generation: number) => {
    const detail = await ordersApi.executionDetail(orderId);
    if (!requestGeneration.isCurrent(generation)) return;
    const sourceOrder = detail.orders.find((order) => order.order_id === orderId);
    if (sourceOrder && detail.account.status !== "VOID" && !Array.isArray(sourceOrder.active_consignments)) {
      throw new Error("上架状态不可用，请重新加载");
    }
    setSourceOrderId(sourceOrder?.order_id ?? null);
    const current = detail.account.status === "VOID" || !sourceOrder ? [] : activeConsignmentListings(sourceOrder).map((item) => ({
      key: item.eventId ?? item.orderId,
      platform: item.platform,
      price: item.price,
      listedAt: item.listedAt,
    }));
    setListed(current);
    if (current.some((item) => item.platform === form.getFieldValue("platform_ids"))) form.setFieldValue("platform_ids", undefined);
    setListingReady(Boolean(sourceOrder) && detail.account.status !== "VOID");
  };

  const reloadListed = async (orderId: number): Promise<boolean> => {
    const generation = requestGeneration.start();
    setListingLoading(true);
    try {
      await refreshListed(orderId, generation);
      if (requestGeneration.isCurrent(generation)) setListingError(null);
      return true;
    } catch (cause) {
      if (requestGeneration.isCurrent(generation)) setListingError(normalizeError(cause));
      return false;
    } finally {
      if (requestGeneration.isCurrent(generation)) setListingLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    setListingError(null);
    setListed([]);
    setListingReady(false);
    setSourceOrderId(props.orderId ?? props.account?.source_order_id ?? null);
    form.resetFields();
    form.setFieldsValue({ listed_at: dayjs().second(0).millisecond(0) });
    const employeeToken = employeesRequest.start();
    void employeesApi.list().then((items) => {
      if (employeesRequest.isCurrent(employeeToken)) setEmployees(items.filter((item) => item.is_active));
    }).catch((cause) => { if (employeesRequest.isCurrent(employeeToken)) setError(normalizeError(cause)); });
    const orderId = props.orderId ?? props.account?.source_order_id;
    if (orderId != null) void reloadListed(orderId);
    return () => { requestGeneration.invalidate(); employeesRequest.invalidate(); };
  }, [employeesRequest, form, open, props.account, props.orderId, requestGeneration]);

  const submit = async (values: { platform_ids?: string; consignment_price?: string | null; listed_at?: Dayjs; operator_user_ids?: number[]; form_extra?: Record<string, unknown> }) => {
    const account = props.account;
    if (!account || !configReady || platformResource.loading || platformResource.error) return;
    const listedAt = values.listed_at ?? dayjs();
    if (!values.platform_ids) return;
    if (!sourceOrderId) {
      setError({ message: "当前账号没有可关联的来源订单，无法登记寄售" });
      return;
    }
    const price = values.consignment_price ?? undefined;
    const orderId = sourceOrderId;
    const submittedSession = session.current();
    await write.run(async () => {
      try {
        await ordersApi.postEvent(orderId, {
          event_type: "OPERATE",
          operation_type: "CONSIGNMENT",
          occurred_on: listedAt.format("YYYY-MM-DD"),
          operator_user_ids: values.operator_user_ids,
          note: `寄售上架：${values.platform_ids}`,
          form_extra_scope: "CONSIGN",
          form_extra: {
            ...formExtraOrUndefined(values.form_extra),
            consignment_platforms: [values.platform_ids],
            ...(price === undefined ? {} : { consignment_price: price }),
            listed_at: listedAt.format("YYYY-MM-DDTHH:mm"),
          },
        });
        appMessage.success(`${values.platform_ids} 已上架，账号仍保持在库`);
        if (session.isCurrent(submittedSession)) {
          form.setFieldsValue({ platform_ids: undefined, consignment_price: null, listed_at: dayjs().second(0).millisecond(0) });
          setListingReady(false);
          void reloadListed(orderId);
          close();
        }
        void Promise.resolve().then(() => props.onCreated(account, orderId))
          .catch(() => appMessage.warning("已上架，但页面刷新失败，请手动刷新"));
      } catch (cause) {
        const error = normalizeError(cause);
        if (session.isCurrent(submittedSession)) setError(error);
        else appMessage.error(`${account.source_order_no ?? `账号 ${account.id}`}：${error.message}`);
      }
    });
  };

  const close = () => {
    session.invalidate();
    props.onClose();
  };

  return (
    <BusinessActionModal size="compact"
      title="登记寄售"
      open={open}
      destroyOnHidden
      onCancel={close}
      footer={
        <CompactActions onCancel={close} divider={false}>
          <PermissionButton permission="order.create" type="primary" aria-label="确认上架" loading={submitting} disabled={!configReady || platformResource.loading || Boolean(platformResource.error)} onClick={() => form.submit()}>
            确认上架
          </PermissionButton>
        </CompactActions>
      }
    >
      <ErrorBanner error={error} />
      <ErrorBanner error={platformResource.error} onRetry={platformResource.retry} retrying={platformResource.loading} />
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
            name="platform_ids"
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
            ) : platformResource.loading ? <span className="muted">寄售平台加载中</span> : platformResource.error ? null : (
              <span className="muted">暂无可用寄售平台，请先在中介业务配置中维护经手平台</span>
            )}
          </CfgItem>
          <CfgItem name="consignment_price" label="寄售价格">
            <InputNumber<string>
              stringMode
              aria-label="寄售价格"
              className="money-input"
              min="0"
              precision={2}
              suffix="元"
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
          <SectionLabelsContext.Provider value={labels}><CustomFieldSections testIdSuffix="inventory-consignment" /></SectionLabelsContext.Provider>
        </BusinessRegistrationForm>
      </FieldConfigContext.Provider>
    </BusinessActionModal>
  );
}
