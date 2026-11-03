import { BarChartOutlined, FileTextOutlined, HomeOutlined, SettingOutlined, TeamOutlined, WalletOutlined } from "@ant-design/icons";
import { createElement } from "react";

/**
 * 主导航。
 * `requiredPermission`：登录用户缺少该权限时，对应导航项隐藏（按角色 RBAC 收口，
 * 与页面内 PermissionGate 双重保险）。未声明则不按权限收口（如工作台恒可见）。
 * 注意：此处仅对「经营中心(report.read)」「资金中心(finance.read)」收口——这两项是
 * 管理/经营视角，普通员工（仅业务录入）不应看到；其余入口保持现状不收口，避免影响
 * 既有角色（如 viewer 仅含 finance.read/report.read）的导航完整性。
 */
export const navigation = [
  { key: "dashboard", label: "工作台", icon: createElement(HomeOutlined) },
  { key: "business", label: "业务中心", icon: createElement(FileTextOutlined) },
  { key: "customers", label: "客户中心", icon: createElement(TeamOutlined) },
  { key: "funds", label: "资金中心", icon: createElement(WalletOutlined), requiredPermission: "finance.read" },
  { key: "operations", label: "经营中心", icon: createElement(BarChartOutlined), requiredPermission: "report.read" },
  { key: "settings", label: "设置", icon: createElement(SettingOutlined) },
];
