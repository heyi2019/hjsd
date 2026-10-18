import { Descriptions, Image, Input, Select, Space, Spin, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Account, AccountExecutionDetail, AccountExecutionEvent, EmployeeOption } from "../shared/api/catalog";
import { executionActionLabel } from "../shared/lib/format";
import { DataTable, MoneyText, StatusTag } from "../shared/ui";
import {
  PROFILE_ACCOUNT_TYPES,
  accountFinancialFlows,
  financeTypeLabel,
  rebateTypeLabel,
} from "./inventory-logic";

type InventoryFinanceRow = {
  key: string;
  type: string;
  direction: "支出" | "收入" | "待结算";
  amount: string;
  rate: string;
  occurredAt: string;
  poolName: string;
  rebateStatus?: string;
  expectedRebate?: string;
  event?: AccountExecutionEvent | null;
};

type InventoryExecutionRow = {
  key: string;
  action: string;
  occurredAt: string;
  amount: string;
  operator: string;
  note: string;
  event: AccountExecutionEvent;
};

function dateTimeMinute(value: string | null | undefined): string {
  if (!value) return "-";
  const normalized = value.replace("T", " ");
  return normalized.length >= 16 ? normalized.slice(0, 16) : `${normalized.slice(0, 10)} 00:00`;
}

function eventDate(detail: AccountExecutionDetail | undefined, eventType: string): string {
  const event = detail?.orders.flatMap((order) => order.events).find((item) => item.event_type === eventType);
  return dateTimeMinute(event?.occurred_at ?? event?.occurred_on);
}

function platformListingDate(detail: AccountExecutionDetail | undefined): string {
  const order = detail?.orders.find((item) => item.order_type === "DG");
  return dateTimeMinute(order?.created_at ?? order?.trade_date);
}

function consignmentPlatforms(detail: AccountExecutionDetail | undefined): string {
  const names = detail?.orders
    .filter((order) => order.order_type === "DG")
    .flatMap((order) => (order.counterparties ?? [])
      .filter((counterparty) => counterparty.role === "PLATFORM")
      .map((counterparty) => counterparty.display_name));
  return names?.length ? names.join("、") : "-";
}

function estimatedRebateAmount(baseAmount: string, rate: string): string {
  const amount = Number(baseAmount) * Number(rate) / 100;
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

export function InventoryDetail({
  row,
  detail,
  loading,
  editing,
  onEdit,
  eventDrafts,
  onEventEdit,
  employees = [],
}: {
  row: Account;
  detail?: AccountExecutionDetail;
  loading: boolean;
  editing?: Account | null;
  onEdit?: (account: Account) => void;
  eventDrafts?: Record<number, { amount: string; note: string | null; operator_user_ids?: number[] }>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) => void;
  employees?: EmployeeOption[];
}) {
  const sourceOrder = detail?.orders[0];
  if (loading && !detail) return <Spin size="small" />;
  const financialFlows = accountFinancialFlows(detail);
  const rebateItems = detail?.orders.flatMap((order) => (
    (order.rebates ?? []).map((rebate) => ({ order, rebate }))
  )) ?? [];
  const expenseFlows = financialFlows.filter(({ cashflow }) => cashflow.direction === "OUT");
  const incomeFlows = financialFlows.filter(({ cashflow }) => cashflow.direction === "IN");
  const totalExpense = expenseFlows.reduce((sum, { cashflow }) => sum + Number(cashflow.amount), 0).toFixed(2);
  const totalIncome = incomeFlows.reduce((sum, { cashflow }) => sum + Number(cashflow.amount), 0).toFixed(2);
  const financeRows: InventoryFinanceRow[] = [
    ...financialFlows.map(({ event, cashflow }) => ({
      key: `flow-${cashflow.flow_no}`,
      type: financeTypeLabel(event?.event_type ?? "", cashflow.direction),
      direction: cashflow.direction === "OUT" ? "支出" as const : "收入" as const,
      amount: cashflow.amount,
      rate: "-",
      occurredAt: dateTimeMinute(cashflow.occurred_at ?? cashflow.occurred_on),
      poolName: cashflow.pool_name || "未分配资金池",
      event,
    })),
    ...rebateItems.map(({ rebate }) => ({
      key: `rebate-${rebate.id}`,
      type: rebateTypeLabel(rebate.rebate_type, rebate.channel),
      direction: rebate.status === "SETTLED" ? "收入" as const : "待结算" as const,
      amount: rebate.base_amount,
      rate: `${rebate.rate}%`,
      occurredAt: dateTimeMinute(rebate.collected_at ?? rebate.collected_on),
      poolName: "-",
      rebateStatus: rebate.status,
      expectedRebate: estimatedRebateAmount(rebate.base_amount, rebate.rate),
    })),
  ];
  const financeColumns: ColumnsType<InventoryFinanceRow> = [
    { title: "类型", dataIndex: "type", key: "type" },
    {
      title: "方向",
      dataIndex: "direction",
      key: "direction",
      render: (value: InventoryFinanceRow["direction"]) => (
        <Typography.Text type={value === "收入" ? "success" : value === "支出" ? "danger" : "secondary"}>{value}</Typography.Text>
      ),
    },
    {
      title: "金额",
      dataIndex: "amount",
      key: "amount",
      align: "right",
      render: (value: string, financeRow) => (
        <div className="inventory-finance-table__amount">
          <MoneyText value={value} />
          {financeRow.expectedRebate ? <Typography.Text type="secondary">预计返点 {financeRow.expectedRebate}</Typography.Text> : null}
        </div>
      ),
    },
    { title: "比例", dataIndex: "rate", key: "rate", align: "right" },
    { title: "时间", dataIndex: "occurredAt", key: "occurredAt" },
    {
      title: "资金池 / 状态",
      key: "poolName",
      render: (_value, financeRow) => financeRow.rebateStatus ? <StatusTag status={financeRow.rebateStatus} /> : financeRow.poolName,
    },
  ];
  const executionRows: InventoryExecutionRow[] = detail?.orders.flatMap((order) => (
    order.events.map((event) => ({
      key: `${order.order_id}-${event.id}`,
      action: executionActionLabel(event.event_type, order.order_type),
      occurredAt: dateTimeMinute(event.occurred_at ?? event.occurred_on),
      amount: event.amount,
      operator: event.operator_names?.length ? event.operator_names.join("、") : event.operator || "-",
      note: event.note || "-",
      event,
    }))
  )) ?? [];
  const executionColumns: ColumnsType<InventoryExecutionRow> = [
    { title: "动作", dataIndex: "action", key: "action" },
    { title: "动作时间", dataIndex: "occurredAt", key: "occurredAt" },
    { title: "操作人", dataIndex: "operator", key: "operator", render: (value: string, item) => editing ? <Select className="inventory-edit-operator" mode="multiple" aria-label={`编辑执行操作人 ${item.action}`} placeholder={value} value={eventDrafts?.[item.event.id]?.operator_user_ids ?? item.event.operator_user_ids ?? []} options={employees.map((employee) => ({ value: employee.id, label: employee.display_name, disabled: !employee.is_active }))} onChange={(ids) => onEventEdit?.(item.event, { operator_user_ids: ids })} /> : value },
    { title: "金额", dataIndex: "amount", key: "amount", align: "right", render: (value: string, item) => editing && item.event.cashflow && ["BUY", "SELL", "COST"].includes(item.event.event_type) ? <Input aria-label={`编辑执行金额 ${item.action}`} inputMode="decimal" value={eventDrafts?.[item.event.id]?.amount ?? value} onChange={(e) => onEventEdit?.(item.event, { amount: e.target.value })} /> : <MoneyText value={value} /> },
    { title: "备注", dataIndex: "note", key: "note", render: (value: string, item) => editing && item.event.cashflow && ["BUY", "SELL", "COST"].includes(item.event.event_type) ? <Input aria-label={`编辑执行备注 ${item.action}`} value={eventDrafts?.[item.event.id]?.note ?? item.event.note ?? ""} onChange={(e) => onEventEdit?.(item.event, { note: e.target.value })} /> : value },
  ];

  return <div className={`inventory-detail${editing ? " inventory-detail--editing" : ""}`}>
    <Descriptions size="small" bordered column={3}>
      <Descriptions.Item label="建档操作人">{row.created_by || "-"}</Descriptions.Item>
      <Descriptions.Item label="登记时间">{dateTimeMinute(sourceOrder?.created_at ?? sourceOrder?.trade_date ?? row.created_at)}</Descriptions.Item>
      <Descriptions.Item label="出售时间">{eventDate(detail, "SELL")}</Descriptions.Item>
      <Descriptions.Item label="下架时间">{eventDate(detail, "CANCEL")}</Descriptions.Item>
      <Descriptions.Item label="寄售时间">{platformListingDate(detail)}</Descriptions.Item>
      <Descriptions.Item label="寄售平台">{consignmentPlatforms(detail)}</Descriptions.Item>
      {!editing ? <>
        <Descriptions.Item label="账号密码">{row.game_password ? <Typography.Text copyable>{row.game_password}</Typography.Text> : "-"}</Descriptions.Item>
        <Descriptions.Item label="渠道 / 区服">{row.channel_region || "-"}</Descriptions.Item>
        <Descriptions.Item label="绑定手机号">{row.bound_phone || "-"}</Descriptions.Item>
        <Descriptions.Item label="有无二次" span={3}>{row.has_secondary == null ? "-" : row.has_secondary ? "有" : "无"}</Descriptions.Item>
      </> : null}
      {!editing && PROFILE_ACCOUNT_TYPES.has(row.inventory_type ?? "") ? <>
        <Descriptions.Item label="账号描述" span={3}>{row.account_description || "-"}</Descriptions.Item>
        <Descriptions.Item label="账号图片" span={3}>
          {row.account_images?.length ? <Image.PreviewGroup><Space wrap>{row.account_images.slice(0, 9).map((src, index) => (
            <Image key={`${src}-${index}`} src={src} alt={`账号图片 ${index + 1}`} width={64} height={64} preview />
          ))}</Space></Image.PreviewGroup> : "-"}
        </Descriptions.Item>
      </> : null}
      {!editing ? <Descriptions.Item label="备注">{row.note || "-"}</Descriptions.Item> : null}
    </Descriptions>
    {editing ? <details className="inventory-edit-more">
      <summary>更多账号资料</summary>
      <div className="inventory-edit-more__fields">
        <label>
          <span>账号密码</span>
          <Input.Password aria-label="编辑账号密码" value={editing.game_password ?? ""} onChange={(e) => onEdit?.({ ...editing, game_password: e.target.value })} />
        </label>
        <label>
          <span>渠道 / 区服</span>
          <Input aria-label="编辑渠道区服" value={editing.channel_region ?? ""} onChange={(e) => onEdit?.({ ...editing, channel_region: e.target.value })} />
        </label>
        <label>
          <span>绑定手机号</span>
          <Input aria-label="编辑绑定手机号" value={editing.bound_phone ?? ""} onChange={(e) => onEdit?.({ ...editing, bound_phone: e.target.value })} />
        </label>
        <label>
          <span>有无二次</span>
          <Select aria-label="编辑有无二次" allowClear value={editing.has_secondary == null ? undefined : editing.has_secondary ? "有" : "无"} options={[{ value: "有", label: "有" }, { value: "无", label: "无" }]} onChange={(v) => onEdit?.({ ...editing, has_secondary: v == null ? null : v === "有" })} />
        </label>
        <label className="inventory-edit-more__note">
          <span>备注</span>
          <Input aria-label="编辑备注" value={editing.note ?? ""} onChange={(e) => onEdit?.({ ...editing, note: e.target.value })} />
        </label>
      </div>
    </details> : null}
    <div className="inventory-execution-list">
      <Typography.Text strong>执行明细</Typography.Text>
      {executionRows.length ? <DataTable className="inventory-execution-table" columns={executionColumns} rows={executionRows} page={1} pageSize={10} total={executionRows.length} onPageChange={() => undefined} pagination={false} rowKey="key" size="small" /> : <Typography.Text type="secondary">暂无已执行事件</Typography.Text>}
    </div>
    <div className="inventory-finance-list">
      <div className="inventory-finance-heading"><Typography.Text strong>资金明细</Typography.Text><Typography.Text type="secondary">{financialFlows.length + rebateItems.length} 笔</Typography.Text></div>
      <div className="inventory-finance-summary">
        <div className="inventory-finance-summary__item"><span>支出</span><strong>{expenseFlows.length} 笔</strong></div>
        <div className="inventory-finance-summary__item"><span>收入</span><strong>{incomeFlows.length} 笔</strong></div>
        <div className="inventory-finance-summary__item inventory-finance-summary__item--amount"><span>总支出</span><MoneyText value={totalExpense} /></div>
        <div className="inventory-finance-summary__item inventory-finance-summary__item--amount"><span>总收入</span><MoneyText value={totalIncome} /></div>
      </div>
      <Typography.Text className="inventory-finance-note" type="secondary">汇总只统计已产生的资金流水，未结算返点不计入总收入</Typography.Text>
      {financeRows.length ? <DataTable className="inventory-finance-table" columns={financeColumns} rows={financeRows} page={1} pageSize={10} total={financeRows.length} onPageChange={() => undefined} pagination={false} rowKey="key" scroll={{ x: 960 }} size="small" /> : null}
      {!financialFlows.length && !rebateItems.length ? <Typography.Text type="secondary">暂无资金明细</Typography.Text> : null}
    </div>
  </div>;
}
