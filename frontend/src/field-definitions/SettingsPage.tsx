/** 设置页入口：只负责响应式布局与主数据/管理面板编排。 */
import { Tabs } from "antd";
import { useEffect, useState, type ReactElement } from "react";
import { AppearancePanel } from "../app/AppearancePanel";
import { ImportWorkbench } from "../imports/ImportWorkbench";
import { PolicySettingsPanel } from "../policy/PolicySettingsPanel";
import { TeamsPanel } from "../users/TeamsPanel";
import { UsersPanel } from "../users/UsersPanel";
import { useSession } from "../shared/state/session";
import { BusinessDictionaryPanel } from "./panels/BusinessDictionaryPanel";
import { ConfigAuditPanel } from "./panels/ConfigAuditPanel";
import { GameTypeSettingsPanel } from "./panels/GameTypeSettingsPanel";
import { IntermediaryPlatformSettingsPanel } from "./panels/IntermediaryPlatformSettingsPanel";
import { OrderTypesPanel } from "./panels/OrderTypesPanel";
import { OrderFormFieldsPanel } from "./panels/OrderFormFieldsPanel";
import { PeriodLocksPanel } from "./panels/PeriodLocksPanel";
import { PoolsAndRoutesPanel } from "./panels/PoolsAndRoutesPanel";
import { SequencesPanel } from "./panels/SequencesPanel";

/** 子面板可跳到任意设置 Tab。 */
type TabNavigate = (key: string, params?: { scope?: string }) => void;
interface TabItem {
  key: string;
  label: string;
  render: (nav: TabNavigate) => ReactElement;
}

export function SettingsPage() {
  const { can } = useSession();
  const [compact, setCompact] = useState(false);
  const [activeTab, setActiveTab] = useState("business-dictionary");
  /** 子面板跳转到表单字段时待消费的作用域。 */
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  // 导入的批次选择提升到父级：SettingsPage 的 Tab 非挂载，切换后回到导入页仍能保留上次所选批次。
  const [importBatchId, setImportBatchId] = useState<number | null>(null);

  const navigate: TabNavigate = (key, params) => {
    if (params?.scope) setPendingScope(params.scope);
    setActiveTab(key);
  };

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 960px)");
    if (!media) return undefined;
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  // 表单字段面板挂载后即消费掉跳转作用域，避免下次进入时被强制拉回上次目标。
  useEffect(() => {
    if (activeTab === "form-fields" && pendingScope) setPendingScope(null);
  }, [activeTab, pendingScope]);

  const items: TabItem[] = [
    { key: "business-dictionary", label: "业务字典", render: () => <BusinessDictionaryPanel /> },
    { key: "order-types", label: "业务类型", render: () => <OrderTypesPanel /> },
    { key: "form-fields", label: "表单字段", render: (nav) => <OrderFormFieldsPanel initialScope={pendingScope ?? undefined} onConfigureGameTypes={() => nav("game-types")} onConfigureIntermediaryPlatforms={() => nav("intermediary-platforms")} /> },
    // 编号序列与业务类型同源（sequence_prefix），读取门控与后端 manage_order_types 一致。
    ...(can("order-type.manage") ? [{ key: "sequences", label: "编号序列", render: () => <SequencesPanel /> }] : []),
    // 资金池与资金路由合并为一个页签：池是主体、路由是去向，页内用视图切换。
    { key: "pools", label: "资金池", render: () => <PoolsAndRoutesPanel /> },
    { key: "game-types", label: "游戏与渠道配置", render: () => <GameTypeSettingsPanel /> },
    { key: "intermediary-platforms", label: "中介业务配置", render: () => <IntermediaryPlatformSettingsPanel /> },
    { key: "policies", label: "经营规则", render: () => <PolicySettingsPanel /> },
    ...(can("finance.period.lock")
      ? [{ key: "period-locks", label: "月结账期锁", render: () => <PeriodLocksPanel /> }]
      : []),
    ...(can("import.manage") ? [{ key: "imports", label: "导入", render: () => <ImportWorkbench embedded batchId={importBatchId} onBatchIdChange={setImportBatchId} /> }] : []),
    ...(can("user.manage")
      ? [
          { key: "users", label: "人员与权限", render: () => <UsersPanel /> },
          { key: "teams", label: "团队管理", render: () => <TeamsPanel /> },
        ]
      : []),
    ...(can("audit.read")
      ? [{ key: "config-audit", label: "改动追溯", render: () => <ConfigAuditPanel /> }]
      : []),
    { key: "appearance", label: "外观", render: () => <AppearancePanel /> },
  ];

  return (
    <section className="ui-stack">
      <Tabs
        className="settings-tabs"
        tabPosition={compact ? "top" : "left"}
        activeKey={activeTab}
        onChange={setActiveTab}
        items={items.map(({ render, ...item }) => ({
          ...item,
          // 隐藏 Tab 不挂载，避免打开设置页时提前请求所有管理数据。
          children: activeTab === item.key ? render(navigate) : null,
        }))}
      />
    </section>
  );
}
