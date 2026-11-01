/** 库存中心：页面壳只负责接入控制器与视图，业务动作按职责拆在 InventoryPanel 目录。 */
import type { BusinessCenterEntryTab } from "../orders/businessCenter";
import { InventoryView } from "./InventoryPanel/InventoryView";
import { useInventoryController } from "./InventoryPanel/useInventoryController";
export { MobileInventoryList, findCancelableBuy, findCancelableEvent, findCancelableSale, moreMenuItems } from "./InventoryPanel/helpers";
import "./InventoryPanel.css";

export function InventoryPanel({ refreshKey = 0, active = true, onOrdersChanged, onNavigate }: {
  refreshKey?: number;
  active?: boolean;
  onOrdersChanged?: () => void;
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
}) {
  const controller = useInventoryController({ refreshKey, active, onOrdersChanged, onNavigate });
  return <InventoryView controller={controller} />;
}
