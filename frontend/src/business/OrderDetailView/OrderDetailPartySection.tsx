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
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
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
  const customerRoles = order?.order_type === "DG"
    ? [{ role: "CONSIGNOR", label: "委托方" }]
    : order?.order_type === "TH"
      ? [{ role: "BUYER", label: "买家" }]
      : [{ role: "SELLER", label: "卖家" }, { role: "BUYER", label: "买家" },
        ...(order?.customers?.some((item) => item.role === "INSTALLMENT_CUSTOMER") ? [{ role: "INSTALLMENT_CUSTOMER", label: "分期客户" }] : [])];
  const counterpartyRole = order?.order_type === "DG" ? "PLATFORM" : order?.order_type === "TH" ? "PEER" : null;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [customersReady, setCustomersReady] = useState(false);
  const [counterpartiesReady, setCounterpartiesReady] = useState(false);
  const [customersError, setCustomersError] = useState<{ message: string; code?: string } | null>(null);
  const [counterpartiesError, setCounterpartiesError] = useState<{ message: string; code?: string } | null>(null);
  const [customerRetry, setCustomerRetry] = useState(0);
  const [counterpartyRetry, setCounterpartyRetry] = useState(0);
  const [selectedCustomers, setSelectedCustomers] = useState<Record<string, number[]>>({});
  const [selectedCounterpartyIds, setSelectedCounterpartyIds] = useState<number[]>([]);
  const [newCustomerNames, setNewCustomerNames] = useState<Record<string, string>>({});
  const [newCounterpartyName, setNewCounterpartyName] = useState("");
  const customerCreate = useAsyncAction();
  const counterpartyCreate = useAsyncAction();

  useEffect(() => {
    if (!editing) return;
    const byRole: Record<string, number[]> = {};
    for (const customer of order?.customers ?? []) {
      const ids = byRole[customer.role] ?? [];
      if (!ids.includes(customer.id)) byRole[customer.role] = [...ids, customer.id];
    }
    setSelectedCustomers(byRole);
    setNewCustomerNames({});
    setSelectedCounterpartyIds([...new Set(order?.counterparties?.map((item) => item.id) ?? [])]);
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

  const addCustomer = async (role: string) => {
    const name = (newCustomerNames[role] ?? "").trim();
    const orderId = meta.orderId;
    if (!name || !orderId || !customersReady) return;
    await customerCreate.run(async () => {
      try {
        const customer = customers.find((item) => item.display_name === name)
          ?? (await customersApi.create({ display_name: name })).customer;
        setCustomers((current) => current.some((item) => item.id === customer.id) ? current : [...current, customer]);
        if (!selectedCustomers[role]?.includes(customer.id)) {
          setSelectedCustomers((current) => ({ ...current, [role]: [...(current[role] ?? []), customer.id] }));
          onPartyEdit?.(orderId, { entity_type: "customer", entity_id: customer.id, role });
        }
        setNewCustomerNames((current) => ({ ...current, [role]: "" }));
      } catch (error) {
        appMessage.error(error instanceof Error ? error.message : "新建客户失败");
      }
    });
  };

  const addCounterparty = async () => {
    const name = newCounterpartyName.trim();
    const orderId = meta.orderId;
    if (!name || !orderId || !counterpartiesReady) return;
    await counterpartyCreate.run(async () => {
      try {
        if (!counterpartyRole) return;
        const counterparty = counterparties.find((item) => item.display_name === name && item.type === counterpartyRole)
          ?? (await counterpartiesApi.create({ display_name: name, type: counterpartyRole }));
        setCounterparties((current) => current.some((item) => item.id === counterparty.id) ? current : [...current, counterparty]);
        if (!selectedCounterpartyIds.includes(counterparty.id)) {
          setSelectedCounterpartyIds((current) => [...current, counterparty.id]);
          onPartyEdit?.(orderId, { entity_type: "counterparty", entity_id: counterparty.id, role: counterpartyRole });
        }
        setNewCounterpartyName("");
      } catch (error) {
        appMessage.error(error instanceof Error ? error.message : "新建渠道方失败");
      }
    });
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
            {customerRoles.map(({ role, label }) => {
              const selected = selectedCustomers[role] ?? [];
              return <div className="order-detail__party-row" key={role}>
                <span className="order-detail__party-label">{label}</span>
                <Select
                  mode="multiple"
                  virtual={customers.length > 100}
                  popupMatchSelectWidth={customers.length > 100}
                  showSearch
                  optionFilterProp="label"
                  aria-label={`选择${label}`}
                  disabled={!customersReady}
                  value={selected}
                  placeholder={`输入或选择${label}，可多选`}
                  searchValue={newCustomerNames[role] ?? ""}
                  onSearch={(value) => setNewCustomerNames((current) => ({ ...current, [role]: value }))}
                  popupRender={(menu) => <>{menu}{newCustomerNames[role]?.trim() ? <div className="order-detail__party-create" onMouseDown={(event) => event.preventDefault()}><PermissionButton permission="customer.create" disabled={!customersReady} loading={customerCreate.pending} type="link" onClick={() => void addCustomer(role)}>{`新建${label}：${newCustomerNames[role].trim()}`}</PermissionButton></div> : null}</>}
                  options={customers.map((item) => ({ value: item.id, label: `${item.customer_no} · ${item.display_name}` }))}
                  onChange={(ids: number[]) => {
                    setSelectedCustomers((current) => ({ ...current, [role]: ids }));
                    setNewCustomerNames((current) => ({ ...current, [role]: "" }));
                    ids.filter((id) => !selected.includes(id)).forEach((id) => onPartyEdit?.(meta.orderId!, { entity_type: "customer", entity_id: id, role }));
                    selected.filter((id) => !ids.includes(id)).forEach((id) => onPartyEdit?.(meta.orderId!, { entity_type: "customer", entity_id: id, role, operation: "remove" }));
                  }}
                />
              </div>;
            })}
            {counterpartyRole ? <div className="order-detail__party-row">
                <span className="order-detail__party-label">合作方</span>
                <Select
                  mode="multiple"
                  virtual={counterparties.length > 100}
                  popupMatchSelectWidth={counterparties.length > 100}
                  showSearch
                  optionFilterProp="label"
                  aria-label="选择合作方"
                  disabled={!counterpartiesReady}
                  value={selectedCounterpartyIds}
                  placeholder="输入或选择合作方，可多选"
                  searchValue={newCounterpartyName}
                  onSearch={setNewCounterpartyName}
                  popupRender={(menu) => <>{menu}{newCounterpartyName.trim() ? <div className="order-detail__party-create" onMouseDown={(event) => event.preventDefault()}><PermissionButton permission="counterparty.manage" disabled={!counterpartiesReady} loading={counterpartyCreate.pending} type="link" onClick={() => void addCounterparty()}>{`新建合作方：${newCounterpartyName.trim()}`}</PermissionButton></div> : null}</>}
                  options={counterparties.filter((item) => item.type === counterpartyRole).map((item) => ({ value: item.id, label: `${item.counterparty_no} · ${item.display_name}` }))}
                  onChange={(ids: number[]) => {
                  const removed = selectedCounterpartyIds.filter((id) => !ids.includes(id));
                    setSelectedCounterpartyIds(ids);
                    setNewCounterpartyName("");
                  const rolesFor = (id: number) => {
                    const roles = order?.counterparties?.filter((item) => item.id === id).map((item) => item.role) ?? [];
                    return roles.length ? roles : [counterpartyRole];
                  };
                  ids.filter((id) => !selectedCounterpartyIds.includes(id)).forEach((id) => rolesFor(id).forEach((role) => onPartyEdit?.(meta.orderId!, { entity_type: "counterparty", entity_id: id, role })));
                  removed.forEach((id) => rolesFor(id).forEach((role) => onPartyEdit?.(meta.orderId!, { entity_type: "counterparty", entity_id: id, role, operation: "remove" })));
                  }}
                />
              </div> : null}
          </Space>
        ) : null}
      </div>
    </div>
  );
}
