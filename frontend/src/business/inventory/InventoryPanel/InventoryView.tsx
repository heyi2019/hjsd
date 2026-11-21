import { ErrorBanner } from "../../../shared/ui";
import { InventoryLedger } from "./InventoryLedger";
import { InventoryModals } from "./InventoryModals";
import type { InventoryController } from "./useInventoryController";
import type { ReactNode } from "react";

export function InventoryView({ controller, createAction }: { controller: InventoryController; createAction?: ReactNode }) {
  return (
    <section className="ui-stack">
      <ErrorBanner error={controller.error} onRetry={() => void controller.load()} />
      <InventoryLedger controller={controller} createAction={createAction} />
      <InventoryModals controller={controller} />
    </section>
  );
}
