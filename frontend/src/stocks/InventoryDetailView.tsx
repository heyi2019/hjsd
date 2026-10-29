import { Descriptions, Image, Input, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { ReactNode } from "react";
import type { Account, AccountAuditEntry, AccountExecutionEvent, EmployeeOption } from "../shared/api/catalog";
import { DataTable, MoneyInput, MoneyText, Select } from "../shared/ui";
import "./InventoryDetail.css";

export type InventoryFinanceRow = {
  key: string;
  type: string;
  direction: "支出" | "收入";
  amount: string;
  rate: string;
  occurredAt: string;
  poolName: string;
  event?: AccountExecutionEvent | null;
};

export type InventoryExecutionRow = {
  key: string;
  action: string;
  occurredAt: string;
  amount: string;
  operator: string;
  note: string;
  event: AccountExecutionEvent;
};

type InventoryDetailMeta = {
  orderNo: string;
  recoveryPlatform: string;
  salePlatform: string;
  orderParties: ReactNode;
  orderNotes: string;
  orderExtras: Array<{ key: string; label: string; value: string; section: string }>;
  createdBy: string;
  registeredAt: string;
  soldAt: string;
  removedAt: string;
  consignmentSummary: string;
  password: string;
  channelRegion: string;
  boundPhone: string;
  secondary: string;
  showProfileFields: boolean;
  accountDescription: string;
  accountImages: string[];
  note: string;
};

export type InventoryPartyLink = {
  id: number;
  display_name: string;
  role: string;
  entityType: "customer" | "counterparty";
};

type InventoryDetailViewProps = {
  meta: InventoryDetailMeta;
  editing?: Account | null;
  onEdit?: (account: Account) => void;
  eventDrafts?: Record<number, { amount: string; note: string | null; operator_user_ids?: number[] }>;
  onEventEdit?: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) => void;
  employees: EmployeeOption[];
  executionRows: InventoryExecutionRow[];
  auditRows: AccountAuditEntry[];
  financeRows: InventoryFinanceRow[];
  expenseCount: number;
  incomeCount: number;
  totalExpense: string;
  totalIncome: string;
  flowCount: number;
};

type InventoryDetailField = { key: string; label: string; value: ReactNode; className?: string };

const ORDER_FIELD_SECTION_LABEL: Record<string, string> = {
  ACCOUNT_PRODUCT: "账号 / 产品补充信息",
  BUSINESS: "业务方案信息",
  DELIVER: "交付信息",
  PARTICIPANT: "参与方信息",
  FINANCE: "费用与资金补充信息",
  EXTRA: "其他补充信息",
};

const EDITABLE_CASHFLOW_EVENTS = new Set(["BUY", "SELL", "COST"]);
const AUDIT_ACTION_LABEL: Record<string, string> = {
  ACCOUNT_CREATE: "创建账号",
  ACCOUNT_UPDATE: "修改账号资料",
  ORDER_CREATE: "创建订单",
  ORDER_UPDATE: "修改订单",
  ORDER_CANCEL: "取消订单",
};
const AUDIT_ENTITY_LABEL: Record<string, string> = {
  account: "账号资料",
  order: "订单",
  inventory_event_edit: "流转记录",
};

function isEditableCashflowEvent(event: AccountExecutionEvent): boolean {
  return Boolean(event.cashflow && EDITABLE_CASHFLOW_EVENTS.has(event.event_type));
}

function formatAuditTime(value: string): string {
  const normalized = value.replace("T", " ");
  return normalized.length >= 16 ? normalized.slice(0, 16) : normalized;
}

export function InventoryDetailView({
  meta,
  editing,
  onEdit,
  eventDrafts,
  onEventEdit,
  employees,
  executionRows,
  auditRows,
  financeRows,
  expenseCount,
  incomeCount,
  totalExpense,
  totalIncome,
  flowCount,
}: InventoryDetailViewProps) {
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
        </div>
      ),
    },
    { title: "比例", dataIndex: "rate", key: "rate", align: "right" },
    { title: "时间", dataIndex: "occurredAt", key: "occurredAt" },
    {
      title: "资金池",
      key: "poolName",
      render: (_value, financeRow) => financeRow.poolName,
    },
  ];

  const executionColumns: ColumnsType<InventoryExecutionRow> = [
    { title: "动作", dataIndex: "action", key: "action" },
    { title: "动作时间", dataIndex: "occurredAt", key: "occurredAt" },
    {
      title: "操作人",
      dataIndex: "operator",
      key: "operator",
      render: (value: string, item) => editing ? (
        <Select
          className="inventory-edit-operator"
          mode="multiple"
          aria-label={`编辑执行操作人 ${item.action}`}
          placeholder={value}
          value={eventDrafts?.[item.event.id]?.operator_user_ids ?? item.event.operator_user_ids ?? []}
          options={employees.map((employee) => ({ value: employee.id, label: employee.display_name, disabled: !employee.is_active }))}
          onChange={(ids) => onEventEdit?.(item.event, { operator_user_ids: ids })}
        />
      ) : value,
    },
    {
      title: "金额",
      dataIndex: "amount",
      key: "amount",
      align: "right",
      render: (value: string, item) => editing && isEditableCashflowEvent(item.event) ? (
        <MoneyInput
          aria-label={`编辑执行金额 ${item.action}`}
          value={eventDrafts?.[item.event.id]?.amount ?? value}
          status={/^\d*(\.\d{0,2})?$/.test(eventDrafts?.[item.event.id]?.amount ?? "") ? undefined : "error"}
          onChange={(event) => {
            const nextValue = event.target.value;
            if (nextValue === "" || /^\d*(\.\d{0,2})?$/.test(nextValue)) onEventEdit?.(item.event, { amount: nextValue });
          }}
        />
      ) : <MoneyText value={value} />,
    },
    {
      title: "备注",
      dataIndex: "note",
      key: "note",
      render: (value: string, item) => editing && isEditableCashflowEvent(item.event) ? (
        <Input aria-label={`编辑执行备注 ${item.action}`} value={eventDrafts?.[item.event.id]?.note ?? item.event.note ?? ""} onChange={(event) => onEventEdit?.(item.event, { note: event.target.value })} />
      ) : value,
    },
  ];
  const auditColumns: ColumnsType<AccountAuditEntry> = [
    { title: "动作", dataIndex: "action", key: "action", render: (value: string) => AUDIT_ACTION_LABEL[value] ?? value },
    { title: "时间", dataIndex: "occurred_at", key: "occurred_at", render: (value: string) => formatAuditTime(value) },
    { title: "操作人", dataIndex: "actor", key: "actor" },
    { title: "对象", dataIndex: "entity_type", key: "entity_type", render: (value: string) => AUDIT_ENTITY_LABEL[value] ?? value },
    { title: "原因", dataIndex: "reason", key: "reason", render: (value: string | null) => value || "-" },
  ];

  const registrationFields: InventoryDetailField[] = [
    { key: "orderNo", label: "订单编号", value: meta.orderNo },
    { key: "createdBy", label: "建档操作人", value: meta.createdBy },
    { key: "registeredAt", label: "登记时间", value: meta.registeredAt, className: "inventory-detail__datetime" },
    { key: "recoveryPlatform", label: "回收平台", value: meta.recoveryPlatform },
    { key: "consignmentSummary", label: "寄售平台 / 寄售时间", value: meta.consignmentSummary, className: "inventory-detail__datetime inventory-detail__multiline" },
    { key: "removedAt", label: "下架时间", value: meta.removedAt, className: "inventory-detail__datetime" },
    { key: "soldAt", label: "出售时间", value: meta.soldAt, className: "inventory-detail__datetime" },
    { key: "salePlatform", label: "售出平台", value: meta.salePlatform },
  ];
  const supplementalFields: InventoryDetailField[] = [
    { key: "password", label: "账号密码", value: meta.password === "-" ? meta.password : <Typography.Text copyable>{meta.password}</Typography.Text> },
    { key: "channelRegion", label: "渠道 / 区服", value: meta.channelRegion },
    { key: "boundPhone", label: "绑定手机号", value: meta.boundPhone },
    { key: "secondary", label: "有无二次", value: meta.secondary },
    ...(meta.showProfileFields ? [
      { key: "description", label: "账号描述", value: meta.accountDescription },
      {
        key: "images",
        label: "账号图片",
        value: meta.accountImages.length ? <Image.PreviewGroup><Space wrap>{meta.accountImages.slice(0, 9).map((src, index) => <Image key={`${src}-${index}`} src={src} alt={`账号图片 ${index + 1}`} width={64} height={64} preview />)}</Space></Image.PreviewGroup> : "-",
      },
    ] : []),
    { key: "note", label: "备注", value: meta.note },
  ];
  const orderSupplementFields: InventoryDetailField[] = [
    ...(meta.orderNotes !== "-" ? [{ key: "orderNotes", label: "订单备注", value: meta.orderNotes, className: "inventory-detail__multiline" }] : []),
    ...meta.orderExtras
      .filter((field) => field.section === "EXTRA")
      .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value })),
  ];
  const extraFieldsBySection = (section: string): InventoryDetailField[] => meta.orderExtras
    .filter((field) => field.section === section)
    .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value }));
  const accountProductExtraFields = extraFieldsBySection("ACCOUNT_PRODUCT");
  const businessExtraFields = extraFieldsBySection("BUSINESS");
  const financeExtraFields = extraFieldsBySection("FINANCE");
  const participantExtraFields = [
    ...extraFieldsBySection("PARTICIPANT"),
    ...(meta.orderParties !== "-" ? [{ key: "orderParties", label: "参与方", value: meta.orderParties, className: "inventory-detail__multiline" }] : []),
  ];
  const renderExtraGroup = (section: string, fields: InventoryDetailField[]) => fields.length ? (
    <div className="inventory-detail__meta-group" key={section}>
      <div className="inventory-detail__meta-group-title">{ORDER_FIELD_SECTION_LABEL[section] ?? section}</div>
      <Descriptions className="inventory-detail__meta-table" size="small" bordered column={4}>
        {fields.map((field) => <Descriptions.Item key={field.key} label={field.label}>{field.value}</Descriptions.Item>)}
      </Descriptions>
    </div>
  ) : null;

  return (
    <div className={`inventory-detail${editing ? " inventory-detail--editing" : ""}`}>
      <div className="inventory-detail__section inventory-detail__section--profile">
        <div className="inventory-detail__section-heading"><Typography.Text strong>账号 / 产品信息</Typography.Text></div>
        <div className="inventory-detail__meta">
          <div className="inventory-detail__meta-group">
            <div className="inventory-detail__meta-group-title">登记与流转信息</div>
            <Descriptions className="inventory-detail__meta-table" size="small" bordered column={4}>
              {registrationFields.map((field) => <Descriptions.Item key={field.key} className={field.className} label={field.label}>{field.value}</Descriptions.Item>)}
            </Descriptions>
          </div>
          {orderSupplementFields.length ? <div className="inventory-detail__meta-group">
            <div className="inventory-detail__meta-group-title">其他补充信息</div>
            <Descriptions className="inventory-detail__meta-table inventory-detail__order-supplement" size="small" bordered column={1}>
              {orderSupplementFields.map((field) => <Descriptions.Item key={field.key} className={field.className} label={field.label}>{field.value}</Descriptions.Item>)}
            </Descriptions>
          </div> : null}
          {renderExtraGroup("ACCOUNT_PRODUCT", accountProductExtraFields)}
          {renderExtraGroup("BUSINESS", businessExtraFields)}
          {renderExtraGroup("PARTICIPANT", participantExtraFields)}
      {!editing ? <div className="inventory-detail__meta-group">
            <div className="inventory-detail__meta-group-title">账号补充资料</div>
            <Descriptions className="inventory-detail__meta-table inventory-detail__long-meta" size="small" bordered column={4}>
              {supplementalFields.map((field) => {
                const fullRow = ["description", "images", "note"].includes(field.key);
                return <Descriptions.Item key={field.key} label={field.label} span={fullRow ? 4 : 1}>{field.value}</Descriptions.Item>;
              })}
            </Descriptions>
          </div> : null}
        </div>
      </div>

      {editing ? <details className="inventory-edit-more">
        <summary>更多账号资料</summary>
        <div className="inventory-edit-more__fields">
          <label><span>账号密码</span><Input.Password aria-label="编辑账号密码" value={editing.game_password ?? ""} onChange={(event) => onEdit?.({ ...editing, game_password: event.target.value })} /></label>
          <label><span>渠道 / 区服</span><Input aria-label="编辑渠道区服" value={editing.channel_region ?? ""} onChange={(event) => onEdit?.({ ...editing, channel_region: event.target.value })} /></label>
          <label><span>绑定手机号</span><Input aria-label="编辑绑定手机号" value={editing.bound_phone ?? ""} onChange={(event) => onEdit?.({ ...editing, bound_phone: event.target.value })} /></label>
          <label><span>有无二次</span><Select aria-label="编辑有无二次" allowClear value={editing.has_secondary == null ? undefined : editing.has_secondary ? "有" : "无"} options={[{ value: "有", label: "有" }, { value: "无", label: "无" }]} onChange={(value) => onEdit?.({ ...editing, has_secondary: value == null ? null : value === "有" })} /></label>
          <label className="inventory-edit-more__note"><span>备注</span><Input aria-label="编辑备注" value={editing.note ?? ""} onChange={(event) => onEdit?.({ ...editing, note: event.target.value })} /></label>
        </div>
      </details> : null}

      <div className="inventory-detail__section inventory-detail__section--execution inventory-execution-list">
        <div className="inventory-detail__section-heading"><Typography.Text strong>流转记录</Typography.Text></div>
        {executionRows.length ? <DataTable className="inventory-execution-table" columns={executionColumns} rows={executionRows} page={1} pageSize={10} total={executionRows.length} onPageChange={() => undefined} pagination={false} rowKey="key" scroll={{ x: "100%" }} size="small" /> : <Typography.Text type="secondary">暂无已执行事件</Typography.Text>}
      </div>

      <div className="inventory-detail__section inventory-audit-list">
        <div className="inventory-detail__section-heading"><Typography.Text strong>操作记录</Typography.Text></div>
        {auditRows.length ? <DataTable className="inventory-execution-table" columns={auditColumns} rows={auditRows} page={1} pageSize={10} total={auditRows.length} onPageChange={() => undefined} pagination={false} rowKey="id" scroll={{ x: "100%" }} size="small" /> : <Typography.Text type="secondary">暂无操作记录</Typography.Text>}
      </div>

      <div className="inventory-detail__section inventory-detail__section--finance inventory-finance-list">
        <div className="inventory-detail__section-heading inventory-finance-heading"><Typography.Text strong>资金明细</Typography.Text><Typography.Text type="secondary">{flowCount} 笔</Typography.Text></div>
        {renderExtraGroup("FINANCE", financeExtraFields)}
        <div className="inventory-finance-summary">
          <div className="inventory-finance-summary__item inventory-finance-summary__item--expense"><span>支出</span><strong>{expenseCount} 笔</strong></div>
          <div className="inventory-finance-summary__item inventory-finance-summary__item--income"><span>收入</span><strong>{incomeCount} 笔</strong></div>
          <div className="inventory-finance-summary__item inventory-finance-summary__item--amount"><span>总支出</span><MoneyText value={totalExpense} /></div>
          <div className="inventory-finance-summary__item inventory-finance-summary__item--amount"><span>总收入</span><MoneyText value={totalIncome} /></div>
        </div>
        <Typography.Text className="inventory-finance-note" type="secondary">汇总只统计已产生的资金流水，未结算返点不计入总收入</Typography.Text>
        {financeRows.length ? <DataTable className="inventory-finance-table" columns={financeColumns} rows={financeRows} page={1} pageSize={10} total={financeRows.length} onPageChange={() => undefined} pagination={false} rowKey="key" scroll={{ x: "100%" }} size="small" /> : null}
        {!financeRows.length ? <Typography.Text type="secondary">暂无资金明细</Typography.Text> : null}
      </div>
    </div>
  );
}
