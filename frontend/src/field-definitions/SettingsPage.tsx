/** 设置页入口：仅保留「配置中心」与少数非业务配置类页签。
 * 原业务配置类独立页签（业务类型 / 表单字段 / 列表字段 / 资金池 /
 * 游戏与渠道 / 中介业务配置 / 参与方来源）已聚合进「配置中心」。
 *
 * 第一性原理：标签 / 权限 / 只读一律取自 configCatalog.ts 单一事实源，组件挂载复用
 * panels/panelRegistry.tsx，消除与注册表重复的硬编码。仅两处必要的显式逻辑：
 *   1. 「配置中心」为容器页签（渲染 ConfigCenterPanel），非注册表项，置于业务字典之后；
 * 注：账期锁定（period-locks）已由 dev 彻底移除（面板与注册表项均删除），
 * 故 SETTINGS_TAB_ORDER 不含该项。 */
import { Tabs } from "antd";
import { useEffect, useState } from "react";
import { useSession } from "../shared/state/session";
import { SETTINGS_ITEMS } from "./configCatalog";
import { PANEL_REGISTRY } from "./panels/panelRegistry";
import { ConfigCenterPanel } from "./panels/ConfigCenterPanel";

interface TabItem {
  key: string;
  label: string;
  render: () => React.ReactElement;
}

/** 设置页左侧页签顺序（不含容器类「配置中心」）；标签 / 权限 / 只读取自 configCatalog。 */
const SETTINGS_TAB_ORDER = [
  "business-dictionary",
  "users",
  "teams",
  "appearance",
] as const;

export function SettingsPage() {
  const { can } = useSession();
  const [compact, setCompact] = useState(false);
  const [activeTab, setActiveTab] = useState("business-dictionary");

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 960px)");
    if (!media) return undefined;
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  const renderTab = (key: string): React.ReactElement => {
    return PANEL_REGISTRY[key]?.(() => {}) ?? null;
  };

  const standaloneTabs: TabItem[] = SETTINGS_TAB_ORDER
    .map((key) => SETTINGS_ITEMS.find((i) => i.key === key))
    .filter(
      (item): item is NonNullable<typeof item> =>
        !!item && (!item.permission || can(item.permission)),
    )
    .map((item) => ({ key: item.key, label: item.label, render: () => renderTab(item.key) }));

  // 「配置中心」为容器页签，置于「业务字典」之后。
  const items: TabItem[] = [
    ...standaloneTabs.filter((t) => t.key === "business-dictionary"),
    { key: "config-center", label: "配置中心", render: () => <ConfigCenterPanel /> },
    ...standaloneTabs.filter((t) => t.key !== "business-dictionary"),
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
