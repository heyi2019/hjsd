import { Descriptions, Input, Space } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OrderDraft } from "./editing/editor-types";
import type { PartyAddition } from "./editing/editor-types";
import type { AccountExecutionCustomer, AccountExecutionDetail } from "../../../shared/api/types/account-execution";
import type { CounterpartyOption, CustomerOption } from "../../../shared/api/customers.api";
import { customersApi, counterpartiesApi } from "../../../shared/api/customers.api";
import { appMessage } from "../../../shared/ui/appFeedback";
import { normalizeError } from "../../../shared/api/client";
import { useAsyncAction } from "../../../shared/hooks/useAsyncAction";
import { useRequestSession } from "../../../shared/hooks/useLatestRequest";
import { ErrorBanner, PermissionButton, Select } from "../../../shared/ui";
import {
  OrderSectionHeading,
  type OrderDetailMeta,
} from "./OrderDetail.shared";

export function buildCustomerOptions(existing: Pick<AccountExecutionCustomer, "id" | "display_name">[], customers: CustomerOption[]) {
  const customerIds = new Set(customers.map((item) => item.id).filter((id) => !Number.isNaN(id)));
  const seen = new Set<number>();
  const oldOptions = existing.flatMap((item) => {
    if (Number.isNaN(item.id) || seen.has(item.id)) return [];
    seen.add(item.id);
    return customerIds.has(item.id) ? [] : [{ value: item.id, label: item.display_name }];
  });
  return [...oldOptions, ...customers.map((item) => ({ value: item.id, label: `${item.customer_no} · ${item.display_name}` }))];
}

export function mergeCustomerSearch(current: CustomerOption[], rows: CustomerOption[], selected: Set<number>) {
  const rowIds = new Set(rows.map((row) => row.id).filter((id) => !Number.isNaN(id)));
  return [...current.filter((item) => selected.has(item.id) && !rowIds.has(item.id)), ...rows];
}

export function getPartySelectionDelta(previous: number[], next: number[]) {
  const previousIds = new Set(previous);
  const nextIds = new Set(next);
  return { added: next.filter((id) => !previousIds.has(id)), removed: previous.filter((id) => !nextIds.has(id)) };
}

export function groupCustomerIdsByRole(customers: Array<Pick<AccountExecutionCustomer, "id" | "role">>): Record<string, number[]> {
  const groups = new Map<string, Set<number>>();
  for (const customer of customers) {
    const ids = groups.get(customer.role) ?? new Set<number>();
    ids.add(customer.id);
    groups.set(customer.role, ids);
  }
  return Object.fromEntries([...groups].map(([role, ids]) => [role, [...ids]]));
}

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
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const customerSearchToken = useRef(0);
  const customerSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [counterparties, setCounterparties] = useState<CounterpartyOption[]>([]);
  const counterpartySearchToken = useRef(0);
  const counterpartySearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [customersReady, setCustomersReady] = useState(false);
  const [counterpartiesReady, setCounterpartiesReady] = useState(false);
  const [customersError, setCustomersError] = useState<{ message: string; code?: string } | null>(null);
  const [counterpartiesError, setCounterpartiesError] = useState<{ message: string; code?: string } | null>(null);
  const [customerRetry, setCustomerRetry] = useState(0);
  const [counterpartyRetry, setCounterpartyRetry] = useState(0);
  const [selectedCustomers, setSelectedCustomers] = useState<Record<string, number[]>>({});
  const [selectedCounterpartyIds, setSelectedCounterpartyIds] = useState<number[]>([]);
  const selectedCounterpartyRef = useRef(selectedCounterpartyIds);
  selectedCounterpartyRef.current = selectedCounterpartyIds;
  const [newCustomerNames, setNewCustomerNames] = useState<Record<string, string>>({});
  const [newCounterpartyName, setNewCounterpartyName] = useState("");
  const customerOptions = useMemo(() => buildCustomerOptions(order?.customers ?? [], customers), [order?.customers, customers]);
  const counterpartyOptions = useMemo(() => {
    const selected = new Set(selectedCounterpartyIds);
    const available = new Set(counterparties.map((item) => item.id));
    const historical = (order?.counterparties ?? []).filter((item) => {
      if (!selected.has(item.id) || available.has(item.id)) return false;
      available.add(item.id);
      return true;
    });
    return [
      ...historical.map((item) => ({ value: item.id, label: item.display_name })),
      ...counterparties.map((item) => ({ value: item.id, label: `${item.counterparty_no} · ${item.display_name}` })),
    ];
  }, [order?.counterparties, counterparties, selectedCounterpartyIds]);
  const customerCreate = useAsyncAction();
  const counterpartyCreate = useAsyncAction();
  const session = useRequestSession(editing ? meta.orderId : null);

  useEffect(() => {
    if (!editing) return;
    setSelectedCustomers(groupCustomerIdsByRole(order?.customers ?? []));
    setNewCustomerNames({});
    const ids = [...new Set(order?.counterparties?.map((item) => item.id) ?? [])];
    selectedCounterpartyRef.current = ids;
    setSelectedCounterpartyIds(ids);
  }, [editing, order]);

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    setCustomersReady(false);
    setCustomersError(null);
    const request = ++customerSearchToken.current;
    void customersApi.options().then((rows) => {
      if (!cancelled && request === customerSearchToken.current) { setCustomers(rows); setCustomersReady(true); }
    }).catch((error) => { if (!cancelled) setCustomersError(normalizeError(error)); });
    return () => { cancelled = true; customerSearchToken.current += 1; if (customerSearchTimer.current) clearTimeout(customerSearchTimer.current); };
  }, [editing, customerRetry]);

  const searchCustomers = (keyword: string) => {
    const request = ++customerSearchToken.current;
    if (customerSearchTimer.current) clearTimeout(customerSearchTimer.current);
    customerSearchTimer.current = setTimeout(() => {
      void customersApi.options(keyword).then((rows) => {
        if (request !== customerSearchToken.current) return;
        const selected = new Set(Object.values(selectedCustomers).flat());
        setCustomers((current) => mergeCustomerSearch(current, rows, selected));
        setCustomersError(null);
      }).catch((error) => { if (request === customerSearchToken.current) setCustomersError(normalizeError(error)); });
    }, 300);
  };

  useEffect(() => {
    if (!editing || !counterpartyRole) return;
    const request = ++counterpartySearchToken.current;
    setCounterpartiesReady(false);
    setCounterpartiesError(null);
    setCounterparties([]);
    setNewCounterpartyName("");
    void counterpartiesApi.options(counterpartyRole).then((rows) => {
      if (request === counterpartySearchToken.current) { setCounterparties(rows); setCounterpartiesReady(true); }
    }).catch((error) => { if (request === counterpartySearchToken.current) setCounterpartiesError(normalizeError(error)); });
    return () => { counterpartySearchToken.current += 1; if (counterpartySearchTimer.current) clearTimeout(counterpartySearchTimer.current); };
  }, [editing, counterpartyRole, counterpartyRetry, meta.orderId]);

  const searchCounterparties = (keyword: string) => {
    setNewCounterpartyName(keyword);
    const request = ++counterpartySearchToken.current;
    if (counterpartySearchTimer.current) clearTimeout(counterpartySearchTimer.current);
    if (!counterpartyRole) return;
    counterpartySearchTimer.current = setTimeout(() => {
      void counterpartiesApi.options(counterpartyRole, keyword).then((rows) => {
        if (request !== counterpartySearchToken.current) return;
        const selected = new Set(selectedCounterpartyRef.current);
        const received = new Set(rows.map((item) => item.id));
        setCounterparties((current) => [...current.filter((item) => selected.has(item.id) && !received.has(item.id)), ...rows]);
        setCounterpartiesError(null);
      }).catch((error) => { if (request === counterpartySearchToken.current) setCounterpartiesError(normalizeError(error)); });
    }, 300);
  };

  const addCustomer = async (role: string) => {
    const name = (newCustomerNames[role] ?? "").trim();
    const orderId = meta.orderId;
    if (!name || !orderId || !customersReady) return;
    const submittedSession = session.current();
    await customerCreate.run(async () => {
      try {
        const existing = (await customersApi.options(name, true))[0];
        if (!session.isCurrent(submittedSession)) return;
        const customer = existing
          ?? (await customersApi.create({ display_name: name })).customer;
        if (!session.isCurrent(submittedSession)) {
          if (!existing) appMessage.warning("客户已创建，订单已切换，请重新选择");
          return;
        }
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
    const submittedSession = session.current();
    await counterpartyCreate.run(async () => {
      try {
        if (!counterpartyRole) return;
        const [existing] = await counterpartiesApi.options(counterpartyRole, name, true);
        if (!session.isCurrent(submittedSession)) return;
        const counterparty = existing
          ?? (await counterpartiesApi.create({ display_name: name, type: counterpartyRole }));
        if (!session.isCurrent(submittedSession)) {
          if (!existing) appMessage.warning("合作方已创建，订单已切换，请重新选择");
          return;
        }
        setCounterparties((current) => current.some((item) => item.id === counterparty.id) ? current : [...current, counterparty]);
        if (!selectedCounterpartyRef.current.includes(counterparty.id)) {
          selectedCounterpartyRef.current = [...selectedCounterpartyRef.current, counterparty.id];
          setSelectedCounterpartyIds((current) => [...current, counterparty.id]);
          onPartyEdit?.(orderId, { entity_type: "counterparty", entity_id: counterparty.id, role: counterpartyRole });
        }
        searchCounterparties("");
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
                  filterOption={false}
                  aria-label={`选择${label}`}
                  disabled={!customersReady}
                  value={selected}
                  placeholder={`输入或选择${label}，可多选`}
                  searchValue={newCustomerNames[role] ?? ""}
                  onSearch={(value) => { setNewCustomerNames((current) => ({ ...current, [role]: value })); searchCustomers(value); }}
                  popupRender={(menu) => <>{menu}{newCustomerNames[role]?.trim() ? <div className="order-detail__party-create" onMouseDown={(event) => event.preventDefault()}><PermissionButton permission="customer.create" disabled={!customersReady} loading={customerCreate.pending} type="link" onClick={() => void addCustomer(role)}>{`新建${label}：${newCustomerNames[role].trim()}`}</PermissionButton></div> : null}</>}
                  options={customerOptions}
                  onChange={(ids: number[]) => {
                    const { added, removed } = getPartySelectionDelta(selected, ids);
                    setSelectedCustomers((current) => ({ ...current, [role]: ids }));
                    setNewCustomerNames((current) => ({ ...current, [role]: "" }));
                    added.forEach((id) => onPartyEdit?.(meta.orderId!, { entity_type: "customer", entity_id: id, role }));
                    removed.forEach((id) => onPartyEdit?.(meta.orderId!, { entity_type: "customer", entity_id: id, role, operation: "remove" }));
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
                  filterOption={false}
                  aria-label="选择合作方"
                  disabled={!counterpartiesReady}
                  value={selectedCounterpartyIds}
                  placeholder="输入或选择合作方，可多选"
                  searchValue={newCounterpartyName}
                  onSearch={searchCounterparties}
                  popupRender={(menu) => <>{menu}{newCounterpartyName.trim() ? <div className="order-detail__party-create" onMouseDown={(event) => event.preventDefault()}><PermissionButton permission="counterparty.manage" disabled={!counterpartiesReady} loading={counterpartyCreate.pending} type="link" onClick={() => void addCounterparty()}>{`新建合作方：${newCounterpartyName.trim()}`}</PermissionButton></div> : null}</>}
                  options={counterpartyOptions}
                  onChange={(ids: number[]) => {
                  const { added, removed } = getPartySelectionDelta(selectedCounterpartyIds, ids);
                    selectedCounterpartyRef.current = ids;
                    setSelectedCounterpartyIds(ids);
                    searchCounterparties("");
                  const rolesById = new Map<number, string[]>();
                  for (const item of order?.counterparties ?? []) {
                    if (Number.isNaN(item.id)) continue;
                    const roles = rolesById.get(item.id) ?? [];
                    roles.push(item.role);
                    rolesById.set(item.id, roles);
                  }
                  const rolesFor = (id: number) => {
                    return rolesById.get(id) ?? [counterpartyRole];
                  };
                  added.forEach((id) => rolesFor(id).forEach((role) => onPartyEdit?.(meta.orderId!, { entity_type: "counterparty", entity_id: id, role })));
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
