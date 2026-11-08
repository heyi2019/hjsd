/** 配置中心（设置页首个页签）：顶部页签菜单 + 下方渲染对应「现有配置页面」。
 *
 * 配置中心聚合字段与业务主数据配置项到一页，
 * 顶部按类别列出这些配置项，点击即在下方切换显示对应的现有面板，不再各自独立成 Tab。
 *
 * 复用单一事实源 configCatalog.ts 的 SETTINGS_ITEMS 注册表（分组 / 标签 / 权限 / 只读），
 * 右侧直接挂载各配置项既有的面板组件（BusinessDictionaryPanel / OrderTypesPanel …），
 * 不重写任何配置逻辑；跨面板跳转（如表单字段里的「配置游戏类型」）改为在本中心内切换选中项。 */
import { Card } from "antd";
import { useState, type ReactElement } from "react";
import {
  CONFIG_GROUP_LABEL,
  SETTINGS_ITEMS,
  SETTINGS_ITEM_BY_KEY,
  type ConfigGroupCode,
} from "../configCatalog";
import { useSession } from "../../shared/state/session";
import { StatusTag } from "../../shared/ui";
import { PANEL_REGISTRY } from "./panelRegistry";
import "./ConfigCenterPanel.css";

/** 分组展示顺序：配置中心聚合字段、业务主数据与工作台提醒。 */
const GROUP_ORDER: ConfigGroupCode[] = ["FIELD", "MASTER", "BUSINESS"];

export function ConfigCenterPanel() {
  const { can } = useSession();
  const [selected, setSelected] = useState<string>("order-types");

  const groups = GROUP_ORDER.map((code) => ({
    code,
    label: CONFIG_GROUP_LABEL[code],
    items: SETTINGS_ITEMS.filter(
      (item) => item.group === code && (!item.permission || can(item.permission)),
    ),
  })).filter((group) => group.items.length > 0);

  const renderPanel = (key: string): ReactElement | null =>
    PANEL_REGISTRY[key]?.(setSelected) ?? null;

  return (
    <div className="config-center">
      <nav className="config-center__nav" aria-label="配置中心导航">
        {groups.map((group) => (
          <div key={group.code} className="config-center__group">
            <div className="config-center__group-title">{group.label}</div>
            {group.items.map((item) => (
              <button
                key={item.key}
                type="button"
                data-testid={`center-nav-${item.key}`}
                className={
                  "config-center__item" +
                  (selected === item.key ? " config-center__item--active" : "")
                }
                onClick={() => setSelected(item.key)}
              >
                <span>{item.label}</span>
                {item.readOnly ? <StatusTag status="DISABLED" label="只读" /> : null}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <section className="config-center__content" data-testid="center-content">
        <Card className="glass" title={SETTINGS_ITEM_BY_KEY.get(selected)?.label ?? "配置"}>
          {renderPanel(selected)}
        </Card>
      </section>
    </div>
  );
}
