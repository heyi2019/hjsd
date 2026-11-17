/** 资金账户设置：只保留「池定义」。2026-11-17 删除业务↔池过账路由后不再需要视图切换。 */
import { Typography } from "antd";
import { PoolsPanel } from "./PoolsPanel";

export function PoolsAndRoutesPanel() {
  return (
    <div className="ui-stack">
      <Typography.Paragraph type="secondary">
        资金账户决定「钱归谁」；未显式指定资金账户的流水进标记为默认的那个池。
      </Typography.Paragraph>
      <PoolsPanel />
    </div>
  );
}
