import { Space, Tabs, Typography } from "antd";
import { useEffect, useState } from "react";
import { CustomerLeadPanel } from "./CustomerLeadPanel";
import "./CustomersPage.css";
import { CustomerPanel } from "./CustomerPanel";
import { CounterpartyPanel } from "./CounterpartyPanel";
import { useBusinessPeriod } from "../shared/state/businessPeriod";
import { BusinessPeriodPicker } from "../shared/ui/BusinessPeriodPicker";
import { ErrorBanner } from "../shared/ui";

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
  customerOrderFilter?: { from?: string; to?: string };
  onClearCustomerOrderFilter?: () => void;
} = {}) {
  const focusedCustomerId = focusCustomerId;
  const focusedCounterpartyId = focusCounterpartyId;
  const periodState = useBusinessPeriod();
  const [orderEntryAll, setOrderEntryAll] = useState(Boolean(customerOrderFilter));
  useEffect(() => {
    if (active && customerOrderFilter) setOrderEntryAll(true);
  }, [active, Boolean(customerOrderFilter), customerOrderFilter?.from, customerOrderFilter?.to]);
  const createdPeriod = customerOrderFilter && orderEntryAll ? null : periodState.period;
  const createdPeriodState = {
    ...periodState,
    period: createdPeriod,
    setPeriod: (period: { from: string; to: string }) => { setOrderEntryAll(false); periodState.setPeriod(period); },
    useCurrentPeriod: () => { setOrderEntryAll(false); periodState.useCurrentPeriod(); },
    usePreviousPeriod: () => { setOrderEntryAll(false); periodState.usePreviousPeriod(); },
    useAllPeriods: () => { setOrderEntryAll(false); periodState.useAllPeriods(); },
  };
  const createdPicker = <Space wrap><Typography.Text>创建日期</Typography.Text><BusinessPeriodPicker label="客户中心创建日期区间" state={createdPeriodState} showAll /></Space>;
  const [activeTab, setActiveTab] = useState(focusedCounterpartyId ? "counterparties" : "customers");
  useEffect(() => {
    if (focusedCounterpartyId) setActiveTab("counterparties");
    else if (focusedCustomerId || customerOrderFilter) setActiveTab("customers");
  }, [focusedCounterpartyId, focusedCustomerId, Boolean(customerOrderFilter), customerOrderFilter?.from, customerOrderFilter?.to]);
  return (
    <section className="ui-stack">
      <ErrorBanner error={periodState.error ? { message: periodState.error } : null} onRetry={periodState.retry} />
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: "customers", label: "客户档案", children: <CustomerPanel active={active && periodState.ready && activeTab === "customers"} focusId={focusedCustomerId} orderFilter={customerOrderFilter} onClearOrderFilter={onClearCustomerOrderFilter} createdPeriod={createdPeriod} createdPicker={<BusinessPeriodPicker label="客户中心创建日期区间" state={createdPeriodState} showAll />} /> },
          { key: "counterparties", label: "合作方（同行/供货方/平台）", children: <CounterpartyPanel active={active && periodState.ready && activeTab === "counterparties"} focusId={focusedCounterpartyId} createdPeriod={createdPeriod} createdPicker={createdPicker} /> },
          { key: "leads", label: "客户需求池", children: <CustomerLeadPanel active={active && periodState.ready && activeTab === "leads"} createdPeriod={createdPeriod} createdPicker={createdPicker} /> },
        ]}
      />
    </section>
  );
}

