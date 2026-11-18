import { ErrorBanner, StatRow } from "../../shared/ui";
import { InventoryLedger } from "./InventoryLedger";
import { InventoryModals } from "./InventoryModals";
import type { InventoryController } from "./useInventoryController";

export function InventoryView({ controller }: { controller: InventoryController }) {
  // 金额与库龄档位由后端汇总（口径见 tests/backend/integration/business/test_inventory_stats.py）；
  // 行数是这张表当前渲染的条数，属于视图事实，不额外绕一次请求。
  const stats = controller.inventoryStats;

  return (
    <section className="ui-stack">
      <ErrorBanner error={controller.error} onRetry={() => void controller.load()} />
      <StatRow
        items={[
          { label: "在库账号", kind: "count", amount: stats ? String(stats.account_count) : "—" },
          { label: "占用成本合计", amount: stats?.occupied_cost ?? "—" },
          { label: "超7天库存账号", kind: "count", amount: stats ? String(stats.over_7d_count) : "—" },
          { label: "超30天库存账号", kind: "count", amount: stats ? String(stats.over_30d_count) : "—" },
        ]}
      />
      <InventoryLedger controller={controller} />
      <InventoryModals controller={controller} />
    </section>
  );
}
