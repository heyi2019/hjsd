/** 配置项 key → 面板挂载函数 的单一注册表（第一性原理：消除 ConfigCenterPanel 内 switch 的重复映射）。
 *
 * 为什么不放进 configCatalog.ts：
 * configCatalog 是纯数据注册表，审计记录页直接复用它做配置项翻译；
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
import { SequencesPanel } from "./SequencesPanel";
import { OrganizationSettingsPanel } from "../../users/OrganizationSettingsPanel";
import { AppearancePanel } from "../../app/AppearancePanel";
import { BusinessReminderSettingsPanel } from "./BusinessReminderSettingsPanel";
import { BusinessPeriodSettingsPanel } from "./BusinessPeriodSettingsPanel";
import { CompanyProfitSettingsPanel } from "./CompanyProfitSettingsPanel";
import { AuditPanel } from "../../audit/AuditPanel";
import { OrderImportPanel } from "./OrderImportPanel";

export type PanelRenderer = (navigate: (key: string) => void) => ReactElement;

export const PANEL_REGISTRY: Record<string, PanelRenderer> = {
  "business-dictionary": () => <BusinessDictionaryPanel />,
  "order-import": () => <OrderImportPanel />,
  "business-reminders": () => <BusinessReminderSettingsPanel />,
  "business-period": () => <BusinessPeriodSettingsPanel />,
  "company-profit": () => <CompanyProfitSettingsPanel />,
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
  "sequences": () => <SequencesPanel />,
  "pools": () => <PoolsAndRoutesPanel />,
  "game-types": () => <GameTypeSettingsPanel />,
  "intermediary-platforms": () => <IntermediaryPlatformSettingsPanel />,
  "party-sources": () => <PartySourceSettingsPanel />,
  "organization": () => <OrganizationSettingsPanel />,
  "audit": () => <AuditPanel />,
  "appearance": () => <AppearancePanel />,
};
