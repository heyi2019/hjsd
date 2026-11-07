/** 配置项 key → 面板挂载函数 的单一注册表（第一性原理：消除 ConfigCenterPanel 内 switch 的重复映射）。
 *
 * 为什么不放进 configCatalog.ts：
 * configCatalog 是纯数据注册表；
 * 若在此引入面板组件会形成循环依赖。故面板挂载逻辑独立成此模块，
 * 由 ConfigCenterPanel 引用，面板本身不反向依赖本模块，无环。
 *
 * navigate 参数为配置中心内部跨面板跳转（如表单字段里的「配置游戏类型」）提供钩子，
 * 由调用方（ConfigCenterPanel）注入 setSelected。

 * 注：账期锁定（period-locks）已由 dev 彻底移除，本注册表不含该项。 */
import type { ReactElement } from "react";
import { BusinessDictionaryPanel } from "./BusinessDictionaryPanel";
import { GameTypeSettingsPanel } from "./GameTypeSettingsPanel";
import { IntermediaryPlatformSettingsPanel } from "./IntermediaryPlatformSettingsPanel";
import { OrderTypesPanel } from "./OrderTypesPanel";
import { OrderFormFieldsPanel } from "./OrderFormFieldsPanel";
import { ListColumnsPanel } from "./ListColumnsPanel";
import { PartySourceSettingsPanel } from "./PartySourceSettingsPanel";
import { PoolsAndRoutesPanel } from "./PoolsAndRoutesPanel";
import { TeamsPanel } from "../../users/TeamsPanel";
import { UsersPanel } from "../../users/UsersPanel";
import { AppearancePanel } from "../../app/AppearancePanel";
import { BusinessReminderSettingsPanel } from "./BusinessReminderSettingsPanel";

export type PanelRenderer = (navigate: (key: string) => void) => ReactElement;

export const PANEL_REGISTRY: Record<string, PanelRenderer> = {
  "business-dictionary": () => <BusinessDictionaryPanel />,
  "business-reminders": () => <BusinessReminderSettingsPanel />,
  "order-types": () => <OrderTypesPanel />,
  "form-fields": (nav) => (
    <OrderFormFieldsPanel
      onConfigureGameTypes={() => nav("game-types")}
      onConfigureIntermediaryPlatforms={() => nav("intermediary-platforms")}
      onConfigurePools={() => nav("pools")}
      onConfigurePartySources={() => nav("party-sources")}
    />
  ),
  "list-columns": () => <ListColumnsPanel />,
  "pools": () => <PoolsAndRoutesPanel />,
  "game-types": () => <GameTypeSettingsPanel />,
  "intermediary-platforms": () => <IntermediaryPlatformSettingsPanel />,
  "party-sources": () => <PartySourceSettingsPanel />,
  "users": () => <UsersPanel />,
  "teams": () => <TeamsPanel />,
  "appearance": () => <AppearancePanel />,
};
