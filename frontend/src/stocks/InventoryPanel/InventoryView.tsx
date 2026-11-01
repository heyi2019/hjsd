import { ErrorBanner, StatRow } from "../../shared/ui";
import { InventoryLedger } from "./InventoryLedger";
import { InventoryModals } from "./InventoryModals";
import type { InventoryController } from "./useInventoryController";

export function InventoryView({ controller }: { controller: InventoryController }) {
  return (
    <section className="ui-stack">
      <ErrorBanner error={controller.error} onRetry={() => void controller.load()} />
      <StatRow
        items={[
          { label: "在库账号", kind: "count", amount: String(controller.visibleRows.length) },
          { label: "占用成本合计", amount: controller.totalCost },
        ]}
      />
      <InventoryLedger controller={controller} />
      <InventoryModals controller={controller} />
    </section>
  );
}
