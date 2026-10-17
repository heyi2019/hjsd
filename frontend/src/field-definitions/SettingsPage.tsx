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
import { OrderTypesPanel } from "./panels/OrderTypesPanel";
import { PoolsPanel } from "./panels/PoolsPanel";

export function SettingsPage() {
  const { can } = useSession();
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 960px)");
    if (!media) return undefined;
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  const items = [
    { key: "business-dictionary", label: "业务字典", children: <BusinessDictionaryPanel /> },
    { key: "order-types", label: "业务类型", children: <OrderTypesPanel /> },
    { key: "pools", label: "资金池", children: <PoolsPanel /> },
    { key: "fields", label: "活字段", children: <FieldsPanel /> },
    { key: "policies", label: "经营规则", children: <PolicySettingsPanel /> },
    ...(can("import.manage") ? [{ key: "imports", label: "标准导入", children: <ImportWorkbench embedded /> }] : []),
    ...(can("user.manage")
      ? [
          { key: "users", label: "人员与权限", children: <UsersPanel /> },
          { key: "teams", label: "团队管理", children: <TeamsPanel /> },
        ]
      : []),
    { key: "appearance", label: "外观", children: <AppearancePanel /> },
  ];

  return (
    <section className="ui-stack">
      <Tabs
        className="settings-tabs"
        tabPosition={compact ? "top" : "left"}
        defaultActiveKey="business-dictionary"
        items={items}
      />
    </section>
  );
}
