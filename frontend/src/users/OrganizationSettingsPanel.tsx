import { Space } from "antd";
import { TeamsPanel } from "./TeamsPanel";
import { UsersPanel } from "./UsersPanel";

/** 组织设置唯一入口：人员权限与团队属于同一组织边界，按上下两个区块统一呈现。 */
export function OrganizationSettingsPanel() {
  return (
    <Space direction="vertical" size={16} className="ui-control-full">
      <UsersPanel />
      <TeamsPanel />
    </Space>
  );
}
