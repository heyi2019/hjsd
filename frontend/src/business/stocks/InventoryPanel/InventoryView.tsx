import { ErrorBanner } from "../../../shared/ui";
import { InventoryLedger } from "./InventoryLedger";
import { InventoryModals } from "./InventoryModals";
import type { InventoryController } from "./useInventoryController";

export function InventoryView({ controller }: { controller: InventoryController }) {
  return (
    <section className="ui-stack">
      <ErrorBanner error={controller.error} onRetry={() => void controller.load()} />
      <InventoryLedger controller={controller} />
      <InventoryModals controller={controller} />
    </section>
  );
}
