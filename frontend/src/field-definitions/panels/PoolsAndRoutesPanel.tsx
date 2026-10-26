/** 资金池设置：把「池定义」与「过账路由」收进同一个页签，用视图切换。
 *
 * 合并理由：池是主体，路由是「订单 → 池」的映射，两者是同一件事的两面。
 * 拆成两个 Tab 时，配完池要切页才能配路由，回答「这个池被哪些订单用到」
 * 也得来回对照。合并后一个页签内即可完成定义与绑定。
 *
 * 两个子面板保持独立实现（各自的数据加载 / 权限门控不变），此处只做视图编排，
 * 且按需挂载——切到哪个视图才拉哪份数据。
 */
import { Segmented, Typography } from "antd";
import { useState } from "react";
import { OrderTypeRoutesPanel } from "./OrderTypeRoutesPanel";
import { PoolsPanel } from "./PoolsPanel";

type View = "pools" | "routes";

const VIEW_OPTIONS: { label: string; value: View }[] = [
  { label: "资金池定义", value: "pools" },
  { label: "过账路由", value: "routes" },
];

export function PoolsAndRoutesPanel() {
  const [view, setView] = useState<View>("pools");

  return (
    <div className="ui-stack">
      <div>
        <Segmented<View>
          aria-label="资金池视图"
          options={VIEW_OPTIONS}
          value={view}
          onChange={(value) => setView(value)}
        />
        <Typography.Paragraph type="secondary" className="ui-form-spaced">
          资金池决定「钱归谁」，过账路由决定「订单的钱落到哪个池」；先定义池，再配路由。
        </Typography.Paragraph>
      </div>
      {view === "pools" ? <PoolsPanel /> : <OrderTypeRoutesPanel />}
    </div>
  );
}
