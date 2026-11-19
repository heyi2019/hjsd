import { Descriptions, Input, Space } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { OrderDraft } from "./editing/use-order-detail-editor";
import type { PartyAddition } from "./editing/use-order-detail-editor";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Counterparty, Customer } from "../../shared/api/types/customers";
import { customersApi, counterpartiesApi } from "../../shared/api/customers.api";
import { loadCustomers } from "../../shared/api/loadCustomers";
import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { ErrorBanner, PermissionButton, Select } from "../../shared/ui";
import {
  OrderSectionHeading,
  type OrderDetailMeta,
} from "./OrderDetail.shared";

/** 板块6：参与方信息 = 参与方链接（客户 / 合作方）+ PARTICIPANT 自定义字段。复用既有渲染（meta.orderParties 与 orderExtras）。 */
export function OrderDetailPartySection({
  meta,
  detail,
  editing = false,
  orderDraft,
  onOrderExtraChange,
  onPartyEdit,
}: {
  meta: OrderDetailMeta;
  detail?: AccountExecutionDetail | null;
  editing?: boolean;
  orderDraft?: OrderDraft;
  onOrderExtraChange?: (key: string, value: unknown) => void;
  onPartyEdit?: (orderId: number, addition: PartyAddition) => void;
}) {
  const order = detail?.orders.find((item) => item.order_id === meta.orderId);
  const customerRole = order?.order_type === "DG" ? "CONSIGNOR" : order?.order_type === "TH" ? "BUYER" : "SELLER";
  const counterpartyRole = order?.order_type === "DG" ? "PLATFORM" : order?.order_type === "TH" ? "PEER" : null;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [customersReady, setCustomersReady] = useState(false);
  const [counterpartiesReady, setCounterpartiesReady] = useState(false);
  const [customersError, setCustomersError] = useState<{ message: string; code?: string } | null>(null);
  const [counterpartiesError, setCounterpartiesError] = useState<{ message: string; code?: string } | null>(null);
  const [customerRetry, setCustomerRetry] = useState(0);
  const [counterpartyRetry, setCounterpartyRetry] = useState(0);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<number[]>([]);
  const [selectedCounterpartyIds, setSelectedCounterpartyIds] = useState<number[]>([]);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCounterpartyName, setNewCounterpartyName] = useState("");

  useEffect(() => {
    if (!editing) return;
    setSelectedCustomerIds(order?.customers?.map((item) => item.id) ?? []);
    setSelectedCounterpartyIds(order?.counterparties?.map((item) => item.id) ?? []);
  }, [editing, order]);

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    setCustomersReady(false);
    setCustomersError(null);
    void loadCustomers("ACTIVE").then((rows) => {
      if (!cancelled) { setCustomers(rows); setCustomersReady(true); }
    }).catch((error) => { if (!cancelled) setCustomersError(normalizeError(error)); });
    return () => { cancelled = true; };
  }, [editing, customerRetry]);

  useEffect(() => {
    if (!editing || !counterpartyRole) return;
    let cancelled = false;
    setCounterpartiesReady(false);
    setCounterpartiesError(null);
    void counterpartiesApi.list({ status: "ACTIVE" }).then((rows) => {
      if (!cancelled) { setCounterparties(rows); setCounterpartiesReady(true); }
    }).catch((error) => { if (!cancelled) setCounterpartiesError(normalizeError(error)); });
    return () => { cancelled = true; };
  }, [editing, counterpartyRole, counterpartyRetry]);

  const addCustomer = async () => {
    const name = newCustomerName.trim();
    if (!name || !meta.orderId || !customersReady) return;
    try {
      const customer = customers.find((item) => item.display_name === name)
        ?? (await customersApi.create({ display_name: name })).customer;
      setCustomers((current) => current.some((item) => item.id === customer.id) ? current : [...current, customer]);
      setSelectedCustomerIds((current) => [...current, customer.id]);
      onPartyEdit?.(meta.orderId, { entity_type: "customer", entity_id: customer.id, role: customerRole });
      setNewCustomerName("");
    } catch (error) {
      appMessage.error(error instanceof Error ? error.message : "新建客户失败");
    }
  };

  const addCounterparty = async () => {
    const name = newCounterpartyName.trim();
    if (!name || !meta.orderId || !counterpartiesReady) return;
    try {
      if (!counterpartyRole) return;
      const counterparty = counterparties.find((item) => item.display_name === name && item.type === counterpartyRole)
        ?? (await counterpartiesApi.create({ display_name: name, type: counterpartyRole }));
      setCounterparties((current) => current.some((item) => item.id === counterparty.id) ? current : [...current, counterparty]);
      setSelectedCounterpartyIds((current) => [...current, counterparty.id]);
      onPartyEdit?.(meta.orderId, { entity_type: "counterparty", entity_id: counterparty.id, role: counterpartyRole });
      setNewCounterpartyName("");
    } catch (error) {
      appMessage.error(error instanceof Error ? error.message : "新建渠道方失败");
    }
  };
  const displayFields = useMemo(() => {
    const participantFields = [
      ...(meta.orderParties !== "-" ? [{ key: "orderParties", label: "参与方", value: meta.orderParties, className: "order-detail__multiline" }] : []),
      ...meta.orderExtras
        .filter((field) => field.section === "PARTICIPANT")
        .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value, className: undefined })),
    ];
    return participantFields.length
      ? participantFields
      : [{ key: "empty-participant", label: "参与方", value: "-", className: undefined }];
  }, [meta.orderExtras, meta.orderParties]);

  return (
    <div className="order-detail__section order-detail__section--party">
      <OrderSectionHeading title="参与方信息" />
      <div className="order-detail__meta">
        <Descriptions className="order-detail__meta-table" size="small" bordered column={4}>
          {displayFields.map((field) => <Descriptions.Item key={field.key} className={field.className} label={field.label}>
            {editing && field.key.startsWith("order-extra-") ? (
              <Input
                aria-label={`编辑${field.label}`}
                value={String(orderDraft?.form_extra?.[field.key.replace("order-extra-", "")] ?? field.value ?? "")}
                onChange={(event) => onOrderExtraChange?.(field.key.replace("order-extra-", ""), event.target.value)}
              />
            ) : field.value}
          </Descriptions.Item>)}
        </Descriptions>
        {editing && meta.orderId != null ? (
          <Space direction="vertical" className="order-detail__party-editor">
            <ErrorBanner error={customersError} onRetry={() => setCustomerRetry((value) => value + 1)} />
            <ErrorBanner error={counterpartiesError} onRetry={() => setCounterpartyRetry((value) => value + 1)} />
            <Space.Compact block>
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="label"
                aria-label="选择客户"
                disabled={!customersReady}
                value={selectedCustomerIds}
                placeholder="选择客户"
                options={customers.map((item) => ({ value: item.id, label: `${item.customer_no} · ${item.display_name}` }))}
                onChange={(ids: number[]) => {
                  const removed = selectedCustomerIds.filter((id) => !ids.includes(id));
                  setSelectedCustomerIds(ids);
                  ids.forEach((id) => onPartyEdit?.(meta.orderId!, { entity_type: "customer", entity_id: id, role: customerRole }));
                  removed.forEach((id) => onPartyEdit?.(meta.orderId!, { entity_type: "customer", entity_id: id, role: customerRole, operation: "remove" }));
                }}
              />
              <Input aria-label="新建客户名称" value={newCustomerName} placeholder="新建客户" onChange={(event) => setNewCustomerName(event.target.value)} />
              <PermissionButton permission="customer.create" disabled={!customersReady} onClick={() => void addCustomer()}>新建客户</PermissionButton>
            </Space.Compact>
            {counterpartyRole ? <Space.Compact block>
                <Select
                  mode="multiple"
                  showSearch
                  optionFilterProp="label"
                  aria-label="选择渠道方"
                  disabled={!counterpartiesReady}
                  value={selectedCounterpartyIds}
                  placeholder="选择渠道方"
                  options={counterparties.map((item) => ({ value: item.id, label: `${item.counterparty_no} · ${item.display_name}` }))}
                  onChange={(ids: number[]) => {
                  const removed = selectedCounterpartyIds.filter((id) => !ids.includes(id));
                    setSelectedCounterpartyIds(ids);
                    ids.forEach((id) => onPartyEdit?.(meta.orderId!, { entity_type: "counterparty", entity_id: id, role: counterpartyRole }));
                  removed.forEach((id) => onPartyEdit?.(meta.orderId!, { entity_type: "counterparty", entity_id: id, role: counterpartyRole, operation: "remove" }));
                  }}
                />
                <Input aria-label="新建渠道方名称" value={newCounterpartyName} placeholder="新建渠道方" onChange={(event) => setNewCounterpartyName(event.target.value)} />
                <PermissionButton permission="counterparty.manage" disabled={!counterpartiesReady} onClick={() => void addCounterparty()}>新建渠道方</PermissionButton>
              </Space.Compact> : null}
          </Space>
        ) : null}
      </div>
    </div>
  );
}
