import { navigate } from "../../router";
import { InventoryTab } from "./InventoryTab";
import { LedgerTab } from "./LedgerTab";
import { CollectionsTab } from "./CollectionsTab";

export type BusinessTab = "inventory" | "ledger" | "collections";

const TABS: { key: BusinessTab; label: string }[] = [
  { key: "inventory", label: "库存" },
  { key: "ledger", label: "台账" },
  { key: "collections", label: "分期" },
];

export function BusinessPage({ tab }: { tab: BusinessTab }) {
  return (
    <div className="h5-page">
      <header className="h5-pagehead">
        <h1>业务</h1>
        <p>库存账号 · 订单台账 · 分期回款</p>
      </header>

      <div className="h5-seg" role="tablist" aria-label="业务子页">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={tab === item.key ? "is-active" : ""}
            onClick={() => navigate(`/business/${item.key}`, true)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "inventory" ? <InventoryTab /> : null}
      {tab === "ledger" ? <LedgerTab /> : null}
      {tab === "collections" ? <CollectionsTab /> : null}
    </div>
  );
}
