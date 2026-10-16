/** 库存：以账号为载体的状态与成本（ACC-01 / RPT-01-01）。回收、提号、代挂账号均从这里进入待售流程。 */
import { Card, Descriptions, Form, Input, Select, Space, Spin, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState, type Key } from "react";
import { accountsApi, type Account, type AccountExecutionDetail } from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import {
  DataTable,
  ErrorBanner,
  MoneyText,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";
import { InventorySaleModal } from "./InventorySaleModal";
import { orderTypeLabel } from "../shared/lib/labels";
import { executionActionLabel } from "../shared/lib/format";

const STATUS_OPTIONS = [
  { value: "IN_STOCK", label: "在库" },
  { value: "INSTALLMENT", label: "分期中" },
  { value: "FOR_SALE", label: "待售" },
  { value: "SOLD", label: "已售" },
  { value: "VOID", label: "失效" },
];

const BUSINESS_MODE_LABEL: Record<string, string> = {
  SELF: "自营",
  DISTRIBUTION: "分销",
};

const INVENTORY_TYPE_LABEL: Record<string, string> = {
  RECOVERY: "回收",
  PICKUP: "提号",
  CONSIGNMENT: "代挂",
};

const BUSINESS_OPTIONS = Object.entries(BUSINESS_MODE_LABEL).map(([value, label]) => ({ value, label }));
const INVENTORY_TYPE_OPTIONS = Object.entries(INVENTORY_TYPE_LABEL).map(([value, label]) => ({ value, label }));

export function InventoryPanel() {
  const [rows, setRows] = useState<Account[]>([]);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [businessMode, setBusinessMode] = useState<string | undefined>(undefined);
  const [inventoryType, setInventoryType] = useState<string | undefined>(undefined);
  const [keyword, setKeyword] = useState("");
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [saleTarget, setSaleTarget] = useState<Account | null>(null);
  const [executionDetails, setExecutionDetails] = useState<Record<number, AccountExecutionDetail>>({});
  const [executionLoading, setExecutionLoading] = useState<Record<number, boolean>>({});
  const [expandedAccountIds, setExpandedAccountIds] = useState<Key[]>([]);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const list = await accountsApi.list(status ? { status } : undefined);
      setRows(list);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleRows = rows.filter((row) => {
    const matchesBusiness = !businessMode || row.business_mode === businessMode;
    const matchesType = !inventoryType || row.inventory_type === inventoryType;
    const text = [row.account_no, row.game_account, row.game_type, row.channel_region, row.platform]
      .filter(Boolean).join(" ").toLowerCase();
    const matchesKeyword = !keyword.trim() || text.includes(keyword.trim().toLowerCase());
    return matchesBusiness && matchesType && matchesKeyword;
  });
  const visibleOccupied = visibleRows.filter((row) => ["IN_STOCK", "INSTALLMENT"].includes(row.status));
  const totalCost = visibleOccupied.reduce((sum, row) => sum + Number(row.cost_amount), 0).toFixed(2);

  const submit = async (values: Record<string, unknown>) => {
    try {
      await accountsApi.create({
        game_account: values.game_account as string,
        platform: values.platform as string,
      });
      form.resetFields();
      await load();
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const columns: ColumnsType<Account> = [
    { title: "账号编号", dataIndex: "account_no" },
    { title: "业务", dataIndex: "business_mode", render: (v: string | null) => v ? BUSINESS_MODE_LABEL[v] ?? v : "-" },
    { title: "类型", dataIndex: "inventory_type", render: (v: string | null) => v ? INVENTORY_TYPE_LABEL[v] ?? v : "-" },
    { title: "产品", dataIndex: "game_type", render: (v: string | null) => v || "-" },
    { title: "账号标识", dataIndex: "game_account" },
    { title: "平台", dataIndex: "platform" },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} /> },
    {
      title: "成本",
      dataIndex: "cost_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "操作",
      key: "actions",
      render: (_value, row) => ["IN_STOCK", "FOR_SALE"].includes(row.status) ? (
        <PermissionButton
          key="sell"
          permission="order.create"
          type="link"
          size="small"
          onClick={() => setSaleTarget(row)}
        >
          售出
        </PermissionButton>
      ) : null,
    },
  ];

  const renderInventoryDetail = (row: Account) => {
    const detail = executionDetails[row.id];
    if (executionLoading[row.id] && !detail) return <Spin size="small" />;

    return <div className="inventory-detail">
    <Descriptions size="small" bordered column={{ xs: 1, sm: 2, md: 3 }}>
      <Descriptions.Item label="库存订单号">{row.account_no}</Descriptions.Item>
      <Descriptions.Item label="建档操作人">{row.created_by || "-"}</Descriptions.Item>
      <Descriptions.Item label="业务">{row.business_mode ? BUSINESS_MODE_LABEL[row.business_mode] ?? row.business_mode : "-"}</Descriptions.Item>
      <Descriptions.Item label="类型">{row.inventory_type ? INVENTORY_TYPE_LABEL[row.inventory_type] ?? row.inventory_type : "-"}</Descriptions.Item>
      <Descriptions.Item label="游戏类型">{row.game_type || "-"}</Descriptions.Item>
      <Descriptions.Item label="游戏账号">
        {row.game_account ? <Typography.Text copyable>{row.game_account}</Typography.Text> : "-"}
      </Descriptions.Item>
      <Descriptions.Item label="账号密码">
        {row.game_password ? <Typography.Text copyable>{row.game_password}</Typography.Text> : "-"}
      </Descriptions.Item>
      <Descriptions.Item label="渠道 / 区服">{row.channel_region || "-"}</Descriptions.Item>
      <Descriptions.Item label="绑定手机号">{row.bound_phone || "-"}</Descriptions.Item>
      <Descriptions.Item label="有无二次">{row.has_secondary == null ? "-" : row.has_secondary ? "有" : "无"}</Descriptions.Item>
      <Descriptions.Item label="平台">{row.platform || "-"}</Descriptions.Item>
      <Descriptions.Item label="风险等级">{row.risk_level || "-"}</Descriptions.Item>
      <Descriptions.Item label="成本"><MoneyText value={row.cost_amount} /></Descriptions.Item>
      <Descriptions.Item label="备注" span={3}>{row.note || "-"}</Descriptions.Item>
    </Descriptions>
    <div className="inventory-execution-list">
      <Typography.Text strong>执行明细</Typography.Text>
      {detail?.orders.length ? detail.orders.map((order) => (
        <div className="inventory-execution-order" key={order.order_id}>
          <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }}>
            <Descriptions.Item label="订单号">{order.order_no}</Descriptions.Item>
            <Descriptions.Item label="类型">{orderTypeLabel(order.order_type)}</Descriptions.Item>
            <Descriptions.Item label="日期">{order.trade_date}</Descriptions.Item>
            <Descriptions.Item label="状态">{order.status}</Descriptions.Item>
            <Descriptions.Item label="订单操作人">{order.operator}</Descriptions.Item>
          </Descriptions>
          {order.events.length ? order.events.map((event) => (
            <Descriptions className="inventory-execution-event" size="small" column={{ xs: 1, sm: 2, md: 4 }} key={event.id}>
              <Descriptions.Item label="动作">{event.event_no} · {executionActionLabel(event.event_type, order.order_type)}</Descriptions.Item>
              <Descriptions.Item label="金额"><MoneyText value={event.amount} /></Descriptions.Item>
              <Descriptions.Item label="发生日期">{event.occurred_on}</Descriptions.Item>
              <Descriptions.Item label="资金流水">{event.cashflow ? `${event.cashflow.flow_no} · ${event.cashflow.pool_name || "-"}` : "无"}</Descriptions.Item>
              <Descriptions.Item label="事件操作人">{event.operator}</Descriptions.Item>
              {event.cashflow ? <Descriptions.Item label="流水操作人">{event.cashflow.operator}</Descriptions.Item> : null}
              {event.note ? <Descriptions.Item label="事件备注" span={4}>{event.note}</Descriptions.Item> : null}
            </Descriptions>
          )) : <Typography.Text type="secondary">暂无已执行事件</Typography.Text>}
        </div>
      )) : <Typography.Text type="secondary">暂无关联订单执行记录</Typography.Text>}
    </div>
  </div>;
  };

  const handleExpand = async (expanded: boolean, row: Account) => {
    const rowKey = String(row.id);
    setExpandedAccountIds((current) => expanded ? [...current, rowKey] : current.filter((id) => id !== rowKey));
    if (!expanded || executionDetails[row.id] || executionLoading[row.id]) return;
    setExecutionLoading((current) => ({ ...current, [row.id]: true }));
    try {
      const detail = await accountsApi.executionDetail(row.id);
      setExecutionDetails((current) => ({ ...current, [row.id]: detail }));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setExecutionLoading((current) => ({ ...current, [row.id]: false }));
    }
  };

  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />

      <StatRow
        items={[
          { label: "在库 / 分期中", kind: "count", amount: String(visibleOccupied.length) },
          { label: "占用成本合计", amount: totalCost },
          { label: "已售", kind: "count", amount: String(visibleRows.filter((r) => r.status === "SOLD").length) },
        ]}
      />

      <Card
        className="glass"
        title="账号台账"
        extra={
          <Space wrap>
            <Select allowClear placeholder="按状态筛选" className="ui-control-width-inventory" value={status} options={STATUS_OPTIONS} onChange={(value) => { setStatus(value); setPage(1); }} />
            <Select allowClear placeholder="按业务筛选" className="ui-control-width-inventory" value={businessMode} options={BUSINESS_OPTIONS} onChange={(value) => { setBusinessMode(value); setPage(1); }} />
            <Select allowClear placeholder="按类型筛选" className="ui-control-width-inventory" value={inventoryType} options={INVENTORY_TYPE_OPTIONS} onChange={(value) => { setInventoryType(value); setPage(1); }} />
            <Input
              allowClear
              value={keyword}
              placeholder="搜索账号 / 产品 / 平台"
              aria-label="搜索库存账号"
              className="ui-control-width-history"
              onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
            />
          </Space>
        }
      >
        <DataTable<Account>
          columns={columns}
          rows={visibleRows}
          page={page}
          pageSize={pageSize}
          total={visibleRows.length}
          controlledPaging
          expandable={{
            expandedRowKeys: expandedAccountIds,
            expandedRowRender: renderInventoryDetail,
            expandRowByClick: true,
            onExpand: (expanded, row) => void handleExpand(expanded, row),
          }}
          emptyText="暂无账号"
          onPageChange={(nextPage, nextSize) => {
            setPage(nextPage);
            setPageSize(nextSize);
          }}
        />
      </Card>

      <Card className="glass" title="新增账号">
        <Form form={form} layout="inline" onFinish={submit}>
          <Form.Item name="game_account" rules={[{ required: true, message: "账号标识必填" }]}>
            <Input placeholder="账号标识" />
          </Form.Item>
          <Form.Item name="platform">
            <Input placeholder="平台" />
          </Form.Item>
          <Form.Item>
            <PermissionButton permission="order.create" type="primary" htmlType="submit">
              建档
            </PermissionButton>
          </Form.Item>
        </Form>
      </Card>

      <InventorySaleModal
        account={saleTarget}
        onClose={() => setSaleTarget(null)}
        onCreated={async () => {
          setSaleTarget(null);
          await load();
        }}
      />
    </section>
  );
}

