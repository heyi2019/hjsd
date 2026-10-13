/** 工作台：动作入口（新建业务）。资金/订单数据总览已于 2026-10-13 迁至
 *  「经营中心 · 数据中心」Tab——工作台只保留「发起动作」，不堆数据。 */
import { Space } from "antd";
import { useState } from "react";
import { EntryCard, EntryRow, PermissionGate } from "../shared/ui";
import { CreateOrderModal } from "../orders/CreateOrderModal";

export function DashboardPage() {
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <section className="ui-stack">
      <EntryRow>
        <PermissionGate permission="order.create">
          <EntryCard
            tone="primary"
            title="新建业务"
            description="点击打开登记弹窗：选业务类型、关联账号/客户，创建草稿"
            onClick={() => setCreateOpen(true)}
          />
        </PermissionGate>
      </EntryRow>

      <Space className="muted" size="small">
        资金与订单数据总览已迁至「经营中心 · 数据中心」Tab 查看。
      </Space>

      <CreateOrderModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => setCreateOpen(false)}
      />
    </section>
  );
}
