/** 库存：以账号为载体的状态与成本（ACC-01 / RPT-01-01）。回收、提号、代挂账号从这里追踪。 */
import { DownloadOutlined } from "@ant-design/icons";
import { Card, Input, Modal, Select, Space, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState, type Key } from "react";
import { accountsApi, employeesApi, type Account, type AccountExecutionDetail, type AccountExecutionEvent, type EmployeeOption } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import {
  DataTable,
  ErrorBanner,
  MoneyText,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";
import { InventorySaleModal } from "./InventorySaleModal";
import { InventoryConsignmentModal } from "./InventoryConsignmentModal";
import { InventoryRebateModal } from "./InventoryRebateModal";
import { InventoryDetail } from "./InventoryDetail";
import { InventoryProfileModal, type InventoryProfileTarget } from "./InventoryProfileModal";
import {
  BUSINESS_MODE_LABEL,
  BUSINESS_OPTIONS,
  EDITABLE_ACCOUNT_TYPES,
  INVENTORY_TYPE_LABEL,
  INVENTORY_TYPE_OPTIONS,
  PROFILE_ACCOUNT_TYPES,
  STATUS_OPTIONS,
  inventoryAge,
} from "./inventory-logic";
import { downloadInventoryCsv } from "./inventory-export";

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
  const [consignmentTarget, setConsignmentTarget] = useState<Account | null>(null);
  const [rebateTarget, setRebateTarget] = useState<Account | null>(null);
  const [executionDetails, setExecutionDetails] = useState<Record<number, AccountExecutionDetail>>({});
  const [executionLoading, setExecutionLoading] = useState<Record<number, boolean>>({});
  const [expandedAccountIds, setExpandedAccountIds] = useState<Key[]>([]);
  const [exporting, setExporting] = useState(false);
  const [profileTarget, setProfileTarget] = useState<InventoryProfileTarget | null>(null);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);
  const [eventDrafts, setEventDrafts] = useState<Record<number, { id: number; expected_amount: string; amount: string; note: string | null; operator_user_ids?: number[] }>>({});
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
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
    const text = [row.game_account, row.game_type, row.channel_region, row.platform]
      .filter(Boolean).join(" ").toLowerCase();
    const matchesKeyword = !keyword.trim() || text.includes(keyword.trim().toLowerCase());
    return matchesBusiness && matchesType && matchesKeyword;
  });
  const visibleOccupied = visibleRows.filter((row) => ["IN_STOCK", "INSTALLMENT"].includes(row.status));
  const totalCost = visibleOccupied.reduce((sum, row) => sum + Number(row.cost_amount), 0).toFixed(2);

  function openProfile(account: Account, mode: InventoryProfileTarget["mode"]) {
    setProfileTarget({ account, mode });
  }

  const columns: ColumnsType<Account> = [
    { title: "订单号", dataIndex: "source_order_no", render: (v: string | null) => v || "-" },
    { title: "业务", dataIndex: "business_mode", render: (v: string | null) => v ? BUSINESS_MODE_LABEL[v] ?? v : "-" },
    { title: "类型", dataIndex: "inventory_type", render: (v: string | null) => v ? INVENTORY_TYPE_LABEL[v] ?? v : "-" },
    { title: "产品", dataIndex: "game_type", render: (v: string | null) => v || "-" },
    { title: "账号标识", dataIndex: "game_account" },
    { title: "平台", dataIndex: "platform" },
    {
      title: "未售时长",
      key: "inventoryAge",
      render: (_value, row) => {
        const age = inventoryAge(row);
        return age ? <StatusTag status={row.status} color={age.color} label={`${age.days}天`} /> : "-";
      },
    },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={v === "VOID" ? "下架" : undefined} /> },
    {
      title: "成本",
      dataIndex: "cost_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "操作",
      key: "actions",
      render: (_value, row) => (
        <Space size="small">
          <PermissionButton
            permission="order.create"
            type="link"
            size="small"
            aria-label="售出"
            disabled={row.status !== 'IN_STOCK'}
            onClick={(event) => {
              event.stopPropagation();
              setSaleTarget(row);
            }}
          >
            售出
          </PermissionButton>
          <PermissionButton
            permission="order.create"
            type="link"
            size="small"
            aria-label="寄售"
            disabled={row.status === "SOLD"}
            onClick={(event) => {
              event.stopPropagation();
              setConsignmentTarget(row);
            }}
          >
            寄售
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            type="link"
            size="small"
            aria-label="下架"
            disabled={row.status === "SOLD"}
            onClick={(event) => {
              event.stopPropagation();
              message.info("下架请按来源订单执行下架流程");
            }}
          >
            下架
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            type="link"
            size="small"
            aria-label="返点"
            onClick={(event) => {
              event.stopPropagation();
              setRebateTarget(row);
            }}
          >
            返点
          </PermissionButton>
          {EDITABLE_ACCOUNT_TYPES.has(row.inventory_type ?? "") ? <>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              aria-label="编辑"
              disabled={editingAccount !== null}
              onClick={(event) => {
                event.stopPropagation();
                setEditingAccount({ ...row });
                setEventDrafts({});
                void employeesApi.list().then(setEmployees).catch((error) => setError(normalizeError(error)));
                void loadExecution(row);
              }}
            >
              编辑
            </PermissionButton>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              aria-label="账号描述"
              disabled={row.status === "SOLD"}
              onClick={(event) => {
                event.stopPropagation();
                openProfile(row, "description");
              }}
            >
              账号描述
            </PermissionButton>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              aria-label="账号图片"
              disabled={row.status === "SOLD"}
              onClick={(event) => {
                event.stopPropagation();
                openProfile(row, "images");
              }}
            >
              账号图片
            </PermissionButton>
          </> : null}
        </Space>
      ),
    },
  ];

  async function saveInline() {
    if (!editingAccount) return;
    setSavingAccount(true);
    try {
      const { id, game_account, game_type, game_password, channel_region, bound_phone, has_secondary, platform, note } = editingAccount;
      const profile = { game_account, game_type, game_password, channel_region, bound_phone, has_secondary, platform, note };
      const events = Object.values(eventDrafts).filter((draft) => {
        const original = executionDetails[id]?.orders.flatMap((order) => order.events).find((event) => event.id === draft.id);
        return original && (draft.amount !== original.amount || draft.note !== (original.note ?? null) || draft.operator_user_ids !== undefined);
      });
      if (events.length) {
        await accountsApi.updateExecution(id, { profile, events });
        setEditingAccount(null);
        setEventDrafts({});
        try {
          const detail = await accountsApi.executionDetail(id);
          setExecutionDetails((current) => ({ ...current, [id]: detail }));
          setRows((current) => current.map((row) => row.id === id ? { ...row, ...detail.account } : row));
        } catch (refreshError) {
          setExecutionDetails((current) => { const next = { ...current }; delete next[id]; return next; });
          setError(normalizeError(refreshError));
          message.warning("修改已保存，但刷新明细失败，请重新加载");
        }
      } else {
        const updated = await accountsApi.updateProfile(id, profile);
        setRows((current) => current.map((row) => row.id === id ? { ...row, ...updated } : row));
      }
      setEditingAccount(null);
      setEventDrafts({});
      message.success("修改已保存");
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSavingAccount(false);
    }
  }

  function updateEventDraft(event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) {
    setEventDrafts((current) => ({ ...current, [event.id]: {
      ...(current[event.id] ?? { id: event.id, expected_amount: event.amount, amount: event.amount, note: event.note ?? null }),
      ...changes,
    } }));
  }

  async function handleExpand(expanded: boolean, row: Account) {
    const rowKey = String(row.id);
    setExpandedAccountIds((current) => expanded ? Array.from(new Set([...current, rowKey])) : current.filter((id) => id !== rowKey));
    if (expanded) await loadExecution(row);
  }

  async function loadExecution(row: Account) {
    if (executionDetails[row.id] || executionLoading[row.id]) return;
    setExecutionLoading((current) => ({ ...current, [row.id]: true }));
    try {
      const detail = await accountsApi.executionDetail(row.id);
      setExecutionDetails((current) => ({ ...current, [row.id]: detail }));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setExecutionLoading((current) => ({ ...current, [row.id]: false }));
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const detailResults = await Promise.all(visibleRows.map(async (row) => {
        try {
          return [row.id, await accountsApi.executionDetail(row.id)] as const;
        } catch {
          return [row.id, undefined] as const;
        }
      }));
      const details = Object.fromEntries(detailResults) as Partial<Record<number, AccountExecutionDetail>>;
      const failedCount = detailResults.filter(([, detail]) => !detail).length;
      downloadInventoryCsv(visibleRows, details);
      if (failedCount) {
        message.warning(`${failedCount} 条明细读取失败，已导出其余可用字段`);
      }
    } finally {
      setExporting(false);
    }
  }

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
            <PermissionButton
              permission="report.read"
              aria-label="导出"
              icon={<DownloadOutlined />}
              loading={exporting}
              onClick={() => void handleExport()}
            >
              导出
            </PermissionButton>
            <Select allowClear placeholder="按状态筛选" className="ui-control-width-inventory" value={status} options={STATUS_OPTIONS} onChange={(value) => { setStatus(value); setPage(1); }} />
            <Select allowClear placeholder="按业务筛选" className="ui-control-width-inventory" value={businessMode} options={BUSINESS_OPTIONS} onChange={(value) => { setBusinessMode(value); setPage(1); }} />
            <Select allowClear placeholder="按类型筛选" className="ui-control-width-inventory" value={inventoryType} options={INVENTORY_TYPE_OPTIONS} onChange={(value) => { setInventoryType(value); setPage(1); }} />
            <Input
              allowClear
              value={keyword}
              placeholder="搜索账号 / 产品 / 平台"
              aria-label="搜索库存账号"
              className="ui-control-width-inventory"
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
          scroll={{ x: "max-content" }}
          expandable={{
            expandedRowKeys: expandedAccountIds,
            expandedRowRender: (row) => (
            <InventoryDetail row={row} detail={executionDetails[row.id]} loading={Boolean(executionLoading[row.id])} />
          ),
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

      <InventorySaleModal
        account={saleTarget}
        onClose={() => setSaleTarget(null)}
        onCreated={async () => {
          setSaleTarget(null);
          await load();
        }}
      />
      <InventoryConsignmentModal
        account={consignmentTarget}
        onClose={() => setConsignmentTarget(null)}
        onCreated={async () => {
          setConsignmentTarget(null);
          await load();
        }}
      />
      <InventoryRebateModal
        account={rebateTarget}
        onClose={() => setRebateTarget(null)}
        onCreated={async () => {
          setRebateTarget(null);
          await load();
        }}
      />
      <Modal title="编辑账号及执行明细" open={Boolean(editingAccount)} width={1200} okText="保存" cancelText="取消" confirmLoading={savingAccount} okButtonProps={{ disabled: Boolean(editingAccount && executionLoading[editingAccount.id]) }} onOk={() => void saveInline()} onCancel={() => { if (!savingAccount) { setEditingAccount(null); setEventDrafts({}); } }}>
        {editingAccount ? <>
          <Space wrap>
            <Input aria-label="编辑账号标识" value={editingAccount.game_account ?? ""} onChange={(e) => setEditingAccount({ ...editingAccount, game_account: e.target.value })} />
            <Input aria-label="编辑产品" value={editingAccount.game_type ?? ""} onChange={(e) => setEditingAccount({ ...editingAccount, game_type: e.target.value })} />
            <Input aria-label="编辑平台" value={editingAccount.platform ?? ""} onChange={(e) => setEditingAccount({ ...editingAccount, platform: e.target.value })} />
          </Space>
          <InventoryDetail row={editingAccount} detail={executionDetails[editingAccount.id]} loading={Boolean(executionLoading[editingAccount.id])} editing={editingAccount} onEdit={setEditingAccount} eventDrafts={eventDrafts} onEventEdit={updateEventDraft} employees={employees} />
        </> : null}
      </Modal>
      <InventoryProfileModal
        target={profileTarget}
        onClose={() => setProfileTarget(null)}
        onSaved={(updated) => {
          setRows((current) => current.map((row) => row.id === updated.id ? { ...row, ...updated } : row));
          setExecutionDetails((current) => {
            const detail = current[updated.id];
            return detail ? { ...current, [updated.id]: { ...detail, account: { ...detail.account, ...updated } } } : current;
          });
        }}
        onError={(error) => setError(normalizeError(error))}
      />
    </section>
  );
}

