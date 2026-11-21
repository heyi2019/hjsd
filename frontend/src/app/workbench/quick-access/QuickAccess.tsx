import { useState } from "react";
import { CreateBusinessModal, type BusinessOrderType } from "../../../business/CreateBusinessModal";
import type { BusinessCenterEntryTab } from "../../../business/businessCenter";
import { EntryCard, EntryRow, PermissionGate } from "../../../shared/ui";

export function QuickAccess({ onNavigate, onCreated }: {
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
  onCreated?: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<BusinessOrderType>("HS");
  const openCreate = (orderType: BusinessOrderType) => {
    setCreateType(orderType);
    setCreateOpen(true);
  };

  return (
    <>
      <EntryRow>
        <PermissionGate permission="order.create">
          <section className="workbench-entry-group workbench-entry-group--no-accent workbench-entry-group--sell" aria-labelledby="workbench-sell-title">
            <div className="workbench-entry-group__heading"><h2 id="workbench-sell-title">售出</h2></div>
            <div className="workbench-entry-group__items">
              <EntryCard tone="primary" eyebrow="主推入口" title="售出库存账号" onClick={() => onNavigate?.("business", "inventory")} />
            </div>
          </section>
          <section className="workbench-entry-group workbench-entry-group--no-accent workbench-entry-group--self-owned" aria-labelledby="workbench-self-owned-title">
            <div className="workbench-entry-group__heading"><h2 id="workbench-self-owned-title">自营</h2></div>
            <div className="workbench-entry-group__items">
              <EntryCard eyebrow="高频业务" title="自营·回收" onClick={() => openCreate("HS")} />
            </div>
          </section>
          <section className="workbench-entry-group workbench-entry-group--no-accent workbench-entry-group--neutral workbench-entry-group--distribution" aria-labelledby="workbench-distribution-title">
            <div className="workbench-entry-group__heading"><h2 id="workbench-distribution-title">分销</h2></div>
            <div className="workbench-entry-group__items">
              <EntryCard title="提号" onClick={() => openCreate("TH")} />
              <EntryCard title="代挂" onClick={() => openCreate("DG")} />
            </div>
          </section>
        </PermissionGate>
      </EntryRow>
      <CreateBusinessModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); onCreated?.(); }}
        initialOrderType={createType}
      />
    </>
  );
}
