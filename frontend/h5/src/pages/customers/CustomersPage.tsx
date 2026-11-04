/**
 * 客户中心外壳：客户 / 合作方 / 需求 三个子页。
 *
 * 为什么把三者放在同一个一级入口：桌面端「客户中心」也是这三个面板，业务上
 * 它们是同一条关系链（客户→需求→成单；合作方是供货/同行侧）。手机上再分一级
 * 会让底栏挤成 7 项，得不偿失。
 */
import { useEffect, useState } from "react";
import { listCustomers, listCounterparties, listLeads } from "../../api";
import { navigate } from "../../router";
import { CustomerTab } from "./tabs/CustomerTab";
import { CounterpartyTab } from "./tabs/CounterpartyTab";
import { LeadTab } from "./tabs/LeadTab";

export type CustomerTabKey = "customers" | "counterparties" | "leads";

const TABS: { key: CustomerTabKey; label: string }[] = [
  { key: "customers", label: "客户" },
  { key: "counterparties", label: "合作方" },
  { key: "leads", label: "需求" },
];

const TAB_PATH: Record<CustomerTabKey, string> = {
  customers: "/customers",
  counterparties: "/customers/counterparties",
  leads: "/customers/leads",
};

const NEW_PATH: Record<CustomerTabKey, string> = {
  customers: "/customers/new",
  counterparties: "/counterparties/new",
  leads: "/leads/new",
};

export function CustomersPage({ tab }: { tab: CustomerTabKey }) {
  const [counts, setCounts] = useState<{ customers: number; counterparties: number; leads: number }>({
    customers: 0,
    counterparties: 0,
    leads: 0,
  });

  // 顶部三个计数只是为了让人知道「有没有漏看」，失败一律按 0 处理，不阻塞列表。
  useEffect(() => {
    let alive = true;
    void Promise.all([
      listCustomers({ limit: 1 }).catch(() => ({ total: 0, items: [] })),
      listCounterparties().catch(() => []),
      listLeads().catch(() => []),
    ]).then(([customerPage, counterparties, leads]) => {
      if (!alive) return;
      setCounts({
        customers: customerPage.total ?? 0,
        counterparties: counterparties.length,
        leads: leads.filter((lead) => lead.status === "OPEN").length,
      });
    });
    return () => {
      alive = false;
    };
  }, [tab]);

  const subtitle =
    tab === "customers"
      ? `共 ${counts.customers} 位客户`
      : tab === "counterparties"
        ? `共 ${counts.counterparties} 个合作方`
        : `${counts.leads} 条待跟进需求`;

  return (
    <div className="h5-page">
      <header className="h5-pagehead">
        <div className="h5-pagehead__row">
          <div>
            <h1>客户</h1>
            <p>{subtitle}</p>
          </div>
          <button type="button" className="h5-pagehead__action" onClick={() => navigate(NEW_PATH[tab])}>
            新建
          </button>
        </div>
      </header>

      <div className="h5-seg" role="tablist" aria-label="客户子页">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={tab === item.key ? "is-active" : ""}
            onClick={() => navigate(TAB_PATH[item.key], true)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "customers" ? <CustomerTab /> : null}
      {tab === "counterparties" ? <CounterpartyTab /> : null}
      {tab === "leads" ? <LeadTab /> : null}
    </div>
  );
}
