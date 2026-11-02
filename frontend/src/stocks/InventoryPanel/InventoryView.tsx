import { ErrorBanner, StatRow } from "../../shared/ui";
import { InventoryLedger } from "./InventoryLedger";
import { InventoryModals } from "./InventoryModals";
import type { InventoryController } from "./useInventoryController";
import { inventoryAge } from "../inventory-logic";

export function InventoryView({ controller }: { controller: InventoryController }) {
  const inventoryOver7Days = controller.visibleRows.filter((row) => (inventoryAge(row)?.days ?? 0) > 7).length;
  const inventoryOver30Days = controller.visibleRows.filter((row) => (inventoryAge(row)?.days ?? 0) > 30).length;

  return (
    <section className="ui-stack">
      <ErrorBanner error={controller.error} onRetry={() => void controller.load()} />
      <StatRow
        items={[
          { label: "在库账号", kind: "count", amount: String(controller.visibleRows.length) },
          { label: "占用成本合计", amount: controller.totalCost },
          { label: "超7天库存账号", kind: "count", amount: String(inventoryOver7Days) },
          { label: "超30天库存账号", kind: "count", amount: String(inventoryOver30Days) },
        ]}
      />
      <InventoryLedger controller={controller} />
      <InventoryModals controller={controller} />
    </section>
  );
}
