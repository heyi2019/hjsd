import { Tabs } from "antd";
import { useEffect, useState } from "react";
import { CustomerLeadPanel } from "./CustomerLeadPanel";
import "./CustomersPage.css";
import { CustomerPanel } from "./CustomerPanel";
import { CounterpartyPanel } from "./CounterpartyPanel";

export function CustomersPage({
  active = true,
  focusCustomerId,
  focusCounterpartyId,
  customerOrderFilter,
  onClearCustomerOrderFilter,
}: {
  active?: boolean;
  focusCustomerId?: number;
  focusCounterpartyId?: number;
  customerOrderFilter?: { from: string; to: string };
  onClearCustomerOrderFilter?: () => void;
} = {}) {
  const focusedCustomerId = focusCustomerId;
  const focusedCounterpartyId = focusCounterpartyId;
  const [activeTab, setActiveTab] = useState(focusedCounterpartyId ? "counterparties" : "customers");
  useEffect(() => {
    if (focusedCounterpartyId) setActiveTab("counterparties");
    else if (focusedCustomerId || customerOrderFilter) setActiveTab("customers");
  }, [focusedCounterpartyId, focusedCustomerId, customerOrderFilter?.from, customerOrderFilter?.to]);
  return (
    <section className="ui-stack">
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: "customers", label: "客户档案", children: <CustomerPanel active={active} focusId={focusedCustomerId} orderFilter={customerOrderFilter} onClearOrderFilter={onClearCustomerOrderFilter} /> },
          { key: "counterparties", label: "合作方（同行/供货方/平台）", children: <CounterpartyPanel active={active} focusId={focusedCounterpartyId} /> },
          { key: "leads", label: "客户需求池", children: <CustomerLeadPanel active={active} /> },
        ]}
      />
    </section>
  );
}

