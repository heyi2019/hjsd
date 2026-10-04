import { Layout, Menu, Select, Space, Typography } from "antd";
import { useState } from "react";
import { navigation } from "./navigation";
import { DEV_ROLES, useSession } from "../shared/state/session";
import { DashboardPage } from "./DashboardPage";
import { OrdersPage } from "../orders/OrdersPage";
import { CustomersPage } from "../customers/CustomersPage";
import { FundsPage } from "../pools/FundsPage";
import { ReportsPage } from "../reporting/ReportsPage";
import { QualityWorkbench } from "../quality/QualityWorkbench";
import { HistoryWorkbench } from "../history/HistoryWorkbench";
import { SettingsPage } from "../field-definitions/SettingsPage";

const { Header, Sider, Content } = Layout;

const PAGES: Record<string, () => JSX.Element> = {
  dashboard: DashboardPage,
  business: OrdersPage,
  customers: CustomersPage,
  funds: FundsPage,
  operations: ReportsPage,
  quality: QualityWorkbench,
  history: HistoryWorkbench,
  settings: SettingsPage,
};

export function AppShell() {
  const [active, setActive] = useState("dashboard");
  const { user, switchUser } = useSession();
  const item = navigation.find((entry) => entry.key === active)!;
  const Page = PAGES[active] ?? DashboardPage;
  return (
    <Layout className="app-shell" style={{ minHeight: "100vh" }}>
      <Sider breakpoint="lg" collapsedWidth={0} theme="light" className="sidebar glass">
        <div className="app-brand">
          黑金时代 <span>ERP</span>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[active]}
          items={navigation}
          onClick={({ key }) => setActive(key)}
        />
      </Sider>
      <Layout>
        <Header className="view-head">
          <Space style={{ width: "100%", justifyContent: "space-between" }}>
            <Typography.Title level={3} style={{ margin: 0 }}>
              {item.label}
            </Typography.Title>
            <Space>
              <Typography.Text type="secondary">当前角色（dev 直通）</Typography.Text>
              <Select
                size="small"
                value={user}
                style={{ width: 140 }}
                options={DEV_ROLES}
                onChange={switchUser}
              />
            </Space>
          </Space>
        </Header>
        <Content className="page-content">
          <Page />
        </Content>
      </Layout>
    </Layout>
  );
}
