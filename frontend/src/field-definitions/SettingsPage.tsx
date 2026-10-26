/** 设置页入口：只负责响应式布局与主数据/管理面板编排。 */
import { Tabs } from "antd";
import { useEffect, useState, type ReactElement } from "react";
import { AppearancePanel } from "../app/AppearancePanel";
import { ImportWorkbench } from "../imports/ImportWorkbench";
import { PolicySettingsPanel } from "../policy/PolicySettingsPanel";
import { PoolAccountsPanel } from "../pools/PoolAccountsPanel";
import { QualityPanel } from "../quality/QualityPanel";
import { TeamsPanel } from "../users/TeamsPanel";
import { UsersPanel } from "../users/UsersPanel";
import { useSession } from "../shared/state/session";
import { BusinessDictionaryPanel } from "./panels/BusinessDictionaryPanel";
import { ConfigOverviewPanel } from "./panels/ConfigOverviewPanel";
import { FieldsPanel } from "./panels/FieldsPanel";
import { GameTypeSettingsPanel } from "./panels/GameTypeSettingsPanel";
import { OptionSetsPanel } from "./panels/OptionSetsPanel";
import { OrderTypesPanel } from "./panels/OrderTypesPanel";
import { OrderFormFieldsPanel } from "./panels/OrderFormFieldsPanel";
import { PeriodLocksPanel } from "./panels/PeriodLocksPanel";
import { PoolsPanel } from "./panels/PoolsPanel";
import { SequencesPanel } from "./panels/SequencesPanel";

/** 总览页可跳到任意 Tab；scope 用于表单字段面板直达具体表单作用域。 */
type TabNavigate = (key: string, params?: { scope?: string }) => void;
interface TabItem {
  key: string;
  label: string;
  render: (nav: TabNavigate) => ReactElement;
}

export function SettingsPage() {
  const { can } = useSession();
  const [compact, setCompact] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  /** 从总览跳转过来时待消费的作用域，只用于表单字段面板的一次性初始值。 */
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  // 标准导入的批次选择提升到父级：SettingsPage 的 Tab 非挂载，切换后回到导入页仍能保留上次所选批次。
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

  // 表单字段面板挂载后即消费掉跳转作用域，避免下次进入时被强制拉回上次的跳转目标。
  useEffect(() => {
    if (activeTab === "form-fields" && pendingScope) setPendingScope(null);
  }, [activeTab, pendingScope]);

  const items: TabItem[] = [
    { key: "overview", label: "配置总览", render: (nav) => <ConfigOverviewPanel onNavigate={nav} /> },
    { key: "business-dictionary", label: "业务字典", render: () => <BusinessDictionaryPanel /> },
    { key: "order-types", label: "业务类型", render: () => <OrderTypesPanel /> },
    // 编号序列与业务类型同源（sequence_prefix），读取门控与后端 manage_order_types 一致。
    ...(can("order-type.manage") ? [{ key: "sequences", label: "编号序列", render: () => <SequencesPanel /> }] : []),
    { key: "pools", label: "资金池", render: () => <PoolsPanel /> },
    ...(can("pool.manage")
      ? [{ key: "pool-accounts", label: "资金池账户", render: () => <PoolAccountsPanel /> }]
      : []),
    { key: "form-fields", label: "表单字段", render: () => <OrderFormFieldsPanel initialScope={pendingScope ?? undefined} /> },
    ...(can("option-set.manage")
      ? [{ key: "option-sets", label: "选项词典", render: () => <OptionSetsPanel /> }]
      : []),
    { key: "fields", label: "活字段", render: () => <FieldsPanel /> },
    { key: "game-types", label: "游戏类型", render: () => <GameTypeSettingsPanel /> },
    { key: "policies", label: "经营规则", render: () => <PolicySettingsPanel /> },
    ...(can("report.read")
      ? [{ key: "quality-issues", label: "质量异常议题", render: () => <QualityPanel /> }]
      : []),
    ...(can("finance.period.lock")
      ? [{ key: "period-locks", label: "月结账期锁", render: () => <PeriodLocksPanel /> }]
      : []),
    ...(can("import.manage") ? [{ key: "imports", label: "标准导入", render: () => <ImportWorkbench embedded batchId={importBatchId} onBatchIdChange={setImportBatchId} /> }] : []),
    ...(can("user.manage")
      ? [
          { key: "users", label: "人员与权限", render: () => <UsersPanel /> },
          { key: "teams", label: "团队管理", render: () => <TeamsPanel /> },
        ]
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
