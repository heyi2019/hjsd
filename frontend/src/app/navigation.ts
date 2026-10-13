import { AlertOutlined, BarChartOutlined, FileTextOutlined, HomeOutlined, SettingOutlined, TeamOutlined, WalletOutlined } from "@ant-design/icons";
import { createElement } from "react";

export const navigation = [
  { key: "dashboard", label: "工作台", icon: createElement(HomeOutlined) },
  { key: "business", label: "业务中心", icon: createElement(FileTextOutlined) },
  { key: "customers", label: "客户中心", icon: createElement(TeamOutlined) },
  { key: "funds", label: "资金中心", icon: createElement(WalletOutlined) },
  { key: "operations", label: "经营中心", icon: createElement(BarChartOutlined) },
  { key: "quality", label: "异常工作台", icon: createElement(AlertOutlined) },
  { key: "settings", label: "设置", icon: createElement(SettingOutlined) },
];
