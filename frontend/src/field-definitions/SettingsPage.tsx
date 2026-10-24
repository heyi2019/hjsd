/** 设置页入口：只负责响应式布局与主数据/管理面板编排。 */
import { Tabs } from "antd";
import { useEffect, useState } from "react";
import { AppearancePanel } from "../app/AppearancePanel";
import { ImportWorkbench } from "../imports/ImportWorkbench";
import { PolicySettingsPanel } from "../policy/PolicySettingsPanel";
import { TeamsPanel } from "../users/TeamsPanel";
import { UsersPanel } from "../users/UsersPanel";
import { useSession } from "../shared/state/session";
import { BusinessDictionaryPanel } from "./panels/BusinessDictionaryPanel";
import { FieldsPanel } from "./panels/FieldsPanel";
import { GameTypeSettingsPanel } from "./panels/GameTypeSettingsPanel";
import { OrderTypesPanel } from "./panels/OrderTypesPanel";
import { PoolsPanel } from "./panels/PoolsPanel";
import { SequencesPanel } from "./panels/SequencesPanel";

export function SettingsPage() {
  const { can } = useSession();
  const [compact, setCompact] = useState(false);
  const [activeTab, setActiveTab] = useState("business-dictionary");
  // 标准导入的批次选择提升到父级：SettingsPage 的 Tab 非挂载，切换后回到导入页仍能保留上次所选批次。
  const [importBatchId, setImportBatchId] = useState<number | null>(null);

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 960px)");
    if (!media) return undefined;
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  const items = [
    { key: "business-dictionary", label: "业务字典", render: () => <BusinessDictionaryPanel /> },
    { key: "order-types", label: "业务类型", render: () => <OrderTypesPanel /> },
    // 编号序列与业务类型同源（sequence_prefix），读取门控与后端 manage_order_types 一致。
    ...(can("order-type.manage") ? [{ key: "sequences", label: "编号序列", render: () => <SequencesPanel /> }] : []),
    { key: "pools", label: "资金池", render: () => <PoolsPanel /> },
    { key: "fields", label: "活字段", render: () => <FieldsPanel /> },
    { key: "game-types", label: "游戏类型", render: () => <GameTypeSettingsPanel /> },
    { key: "policies", label: "经营规则", render: () => <PolicySettingsPanel /> },
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
          children: activeTab === item.key ? render() : null,
        }))}
      />
    </section>
  );
}
