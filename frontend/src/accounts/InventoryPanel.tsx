/** 库存：以账号为载体的状态与成本（ACC-01 / RPT-01-01）。回收、提号、代挂账号从这里追踪。 */
import { DownloadOutlined } from "@ant-design/icons";
import { Card, Dropdown, Form, Input, Modal, Select, Space, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState, type Key } from "react";
import { accountsApi, employeesApi, installmentsApi, ordersApi, type Account, type AccountExecutionDetail, type AccountExecutionEvent, type EmployeeOption } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { money, today } from "../shared/lib/format";
import {
  DataTable,
  ErrorBanner,
  MoneyInput,
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
  EDITABLE_ACCOUNT_TYPES,
  INVENTORY_TYPE_LABEL,
  PROFILE_ACCOUNT_TYPES,
  inventoryAge,
} from "./inventory-logic";
import { downloadInventoryCsv } from "./inventory-export";
import { useOptionSet } from "../shared/lib/optionSets";
import { requiredMoneyRules } from "../shared/lib/validators";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../orders/ConfigurableField";

export function InventoryPanel({ refreshKey = 0 }: { refreshKey?: number }) {
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
  const [cancelTarget, setCancelTarget] = useState<{ account: Account; orderId: number; eventId: number; amount: string; portion: string } | null>(null);
  const [voidTarget, setVoidTarget] = useState<{ account: Account; orderId: number; eventId: number; amount: string; portion: string } | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [installmentCancelTarget, setInstallmentCancelTarget] = useState<{ account: Account; installmentId: number; contractType: string } | null>(null);
  const [refundForm] = Form.useForm();
  const [voidForm] = Form.useForm();
  const [instCancelForm] = Form.useForm();
  const [invEditExtraForm] = Form.useForm();
  const [cancelling, setCancelling] = useState(false);
  const [cancellingInstallment, setCancellingInstallment] = useState(false);
  const [eventDrafts, setEventDrafts] = useState<Record<number, { id: number; expected_amount: string; amount: string; note: string | null; operator_user_ids?: number[] }>>({});
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  // T20：筛选项从「选项词典」配置读取（库存状态 / 业务 / 类型）。
  const statusOptions = useOptionSet("INVENTORY_STATUS");
  const businessOptions = useOptionSet("INVENTORY_BUSINESS");
  const inventoryTypeOptions = useOptionSet("INVENTORY_TYPE");
  const load = useCallback(async () => {
    try {
      const list = await accountsApi.list(status ? { status } : undefined);
      setRows([...list].sort((a, b) => b.id - a.id));
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (refreshKey > 0) setPage(1);
  }, [refreshKey]);

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

  function openEditor(account: Account) {
    setEditingAccount({ ...account });
    setEventDrafts({});
    void employeesApi.list().then(setEmployees).catch((cause) => setError(normalizeError(cause)));
    void loadExecution(account);
  }

  function findCancelableSale(detail: AccountExecutionDetail) {
    for (const order of [...detail.orders].reverse()) {
      for (const event of [...order.events].reverse()) {
        if (event.event_type !== "SELL") continue;
        const cancelledAmount = order.events
          .filter((item) => item.event_type === "CANCEL" && item.offset_event_id === event.id)
          .reduce((sum, item) => sum + Number(item.amount), 0);
        const remaining = Number(event.amount) - cancelledAmount;
        if (remaining > 0) {
          return {
            orderId: order.order_id,
            eventId: event.id,
            amount: remaining.toFixed(2),
            portion: event.portion,
          };
        }
      }
    }
    return null;
  }

  /** 下架（VOID）走后端「全额冲销买入事件」路径：CANCEL offset=BUY 且全额消耗时账号转入 VOID
   * （core/state_machine.py ACCOUNT_TRANSITIONS；orders/events.py _apply_account_effect）。 */
  function findCancelableBuy(detail: AccountExecutionDetail) {
    for (const order of [...detail.orders].reverse()) {
      for (const event of [...order.events].reverse()) {
        if (event.event_type !== "BUY") continue;
        const cancelledAmount = order.events
          .filter((item) => item.event_type === "CANCEL" && item.offset_event_id === event.id)
          .reduce((sum, item) => sum + Number(item.amount), 0);
        const remaining = Number(event.amount) - cancelledAmount;
        if (remaining > 0) {
          return {
            orderId: order.order_id,
            eventId: event.id,
            amount: remaining.toFixed(2),
            portion: event.portion,
          };
        }
      }
    }
    return null;
  }

  async function openVoid(account: Account) {
    try {
      const detail = executionDetails[account.id] ?? await accountsApi.executionDetail(account.id);
      setExecutionDetails((current) => ({ ...current, [account.id]: detail }));
      const buy = findCancelableBuy(detail);
      if (!buy) {
        message.warning("未找到可冲销的买入流水，无法下架");
        return;
      }
      setVoidTarget({ account, ...buy });
      voidForm.setFieldsValue({ reason: undefined });
    } catch (cause) {
      setError(normalizeError(cause));
    }
  }

  async function submitVoid(values: { reason: string; form_extra?: Record<string, unknown> }) {
    if (!voidTarget) return;
    setVoiding(true);
    try {
      await ordersApi.postEvent(voidTarget.orderId, {
        event_type: "CANCEL",
        amount: voidTarget.amount,
        occurred_on: today(),
        portion: voidTarget.portion,
        offset_event_id: voidTarget.eventId,
        reason: values.reason.trim(),
        form_extra: values.form_extra,
        note: "账号下架，冲销买入",
      });
      message.success("账号已下架");
      const accountId = voidTarget.account.id;
      setVoidTarget(null);
      voidForm.resetFields();
      setExecutionDetails((current) => {
        const next = { ...current };
        delete next[accountId];
        return next;
      });
      await load();
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setVoiding(false);
    }
  }

  async function openCancellation(account: Account) {
    try {
      const detail = executionDetails[account.id] ?? await accountsApi.executionDetail(account.id);
      setExecutionDetails((current) => ({ ...current, [account.id]: detail }));
      const sale = findCancelableSale(detail);
      if (!sale) {
        message.warning("未找到可退款的售出流水，请先检查交易明细");
        return;
      }
      setCancelTarget({ account, ...sale });
      refundForm.setFieldsValue({ refund_amount: sale.amount, reason: undefined });
    } catch (cause) {
      setError(normalizeError(cause));
    }
  }

  async function openInstallmentCancellation(account: Account) {
    try {
      const detail = executionDetails[account.id] ?? await accountsApi.executionDetail(account.id);
      setExecutionDetails((current) => ({ ...current, [account.id]: detail }));
      const order = [...detail.orders].reverse().find((item) => item.status === "ACTIVE");
      if (!order) {
        message.warning("未找到进行中的分期订单");
        return;
      }
      const contracts = await installmentsApi.list({ order_id: order.order_id });
      const contract = contracts.find((item) => ["PENDING", "ACTIVE", "OVERDUE", "SETTLED"].includes(item.status));
      if (!contract) {
        message.warning("未找到可终止的分期合约");
        return;
      }
      setInstallmentCancelTarget({ account, installmentId: contract.id, contractType: contract.contract_type });
      instCancelForm.setFieldsValue({ reason: undefined });
    } catch (cause) {
      setError(normalizeError(cause));
    }
  }

  async function submitCancellation(values: { refund_amount: string; reason: string; form_extra?: Record<string, unknown> }) {
    if (!cancelTarget) return;
    if (!values.refund_amount?.trim() || Number.isNaN(Number(values.refund_amount)) || Number(values.refund_amount) <= 0) {
      message.error("请输入有效的退款金额");
      return;
    }
    setCancelling(true);
    try {
      await ordersApi.postEvent(cancelTarget.orderId, {
        event_type: "CANCEL",
        amount: values.refund_amount.trim(),
        occurred_on: new Date().toISOString().slice(0, 10),
        portion: cancelTarget.portion,
        offset_event_id: cancelTarget.eventId,
        reason: values.reason.trim(),
        form_extra: values.form_extra,
        note: "取消交易，原路退款",
      });
      message.success(cancelTarget.account.inventory_type === "PICKUP"
        ? "退款已登记，提号交易已结束"
        : "退款已登记，账号已回到在库");
      const accountId = cancelTarget.account.id;
      setCancelTarget(null);
      refundForm.resetFields();
      setExecutionDetails((current) => {
        const next = { ...current };
        delete next[accountId];
        return next;
      });
      await load();
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setCancelling(false);
    }
  }

  async function submitInstallmentCancellation(values: { reason: string; form_extra?: Record<string, unknown> }) {
    if (!installmentCancelTarget || !values.reason?.trim()) {
      message.error("请填写退款原因");
      return;
    }
    setCancellingInstallment(true);
    try {
      await installmentsApi.cancel(installmentCancelTarget.installmentId, {
        cancelled_on: new Date().toISOString().slice(0, 10),
        reason: values.reason.trim(),
        form_extra: values.form_extra,
      });
      message.success(installmentCancelTarget.contractType === "PICKUP_SALE" ? "退款已登记，提号交易已结束" : "退款已登记，账号已回到库存");
      const accountId = installmentCancelTarget.account.id;
      setInstallmentCancelTarget(null);
      instCancelForm.resetFields();
      setExecutionDetails((current) => {
        const next = { ...current };
        delete next[accountId];
        return next;
      });
      await load();
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setCancellingInstallment(false);
    }
  }

  function handleMoreAction(key: string, row: Account) {
    if (key === "remove") {
      void openVoid(row);
      return;
    }
    if (key === "cancel") {
      void (row.status === "INSTALLMENT" ? openInstallmentCancellation(row) : openCancellation(row));
      return;
    }
    if (key === "description") {
      openProfile(row, "description");
      return;
    }
    if (key === "images") openProfile(row, "images");
  }

  const columns: ColumnsType<Account> = [
    { title: "订单号", dataIndex: "source_order_no", render: (v: string | null) => v || "-" },
    { title: "业务", dataIndex: "business_mode", render: (v: string | null) => v ? BUSINESS_MODE_LABEL[v] ?? v : "-", className: "ui-col-md-up", onCell: () => ({ className: "ui-col-md-up" }) },
    { title: "类型", dataIndex: "inventory_type", render: (v: string | null) => v ? INVENTORY_TYPE_LABEL[v] ?? v : "-" },
    { title: "产品", dataIndex: "game_type", render: (v: string | null) => v || "-", className: "ui-col-md-up", onCell: () => ({ className: "ui-col-md-up" }) },
    { title: "账号标识", dataIndex: "game_account", className: "ui-col-md-up", onCell: () => ({ className: "ui-col-md-up" }) },
    { title: "平台", dataIndex: "platform", className: "ui-col-md-up", onCell: () => ({ className: "ui-col-md-up" }) },
    {
      title: "未售时长",
      className: "ui-col-md-up",
      onCell: () => ({ className: "ui-col-md-up" }),
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
        <Space size={2}>
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
            disabled={row.status === "SOLD" || row.status === "VOID"}
            onClick={(event) => {
              event.stopPropagation();
              void openVoid(row);
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
                openEditor(row);
              }}
            >
              编辑
            </PermissionButton>
            <Dropdown
              trigger={["click"]}
              placement="bottomRight"
              menu={{
                items: [
                  { key: "remove", label: "下架", disabled: row.status === "SOLD" || row.status === "VOID" },
                  { key: "cancel", label: row.status === "INSTALLMENT" ? "终止分期并退款" : "取消交易", danger: true, disabled: !["SOLD", "INSTALLMENT"].includes(row.status) },
                  { key: "description", label: "账号描述", disabled: row.status === "SOLD" },
                  { key: "images", label: "账号图片", disabled: row.status === "SOLD" },
                ],
                onClick: ({ key }) => handleMoreAction(key, row),
              }}
            >
              <PermissionButton
                permission="order.create"
                type="link"
                size="small"
                aria-label="更多"
                onClick={(event) => event.stopPropagation()}
              >
                更多
              </PermissionButton>
            </Dropdown>
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
      const profile = { game_account, game_type, game_password, channel_region, bound_phone, has_secondary, platform, note, form_extra: invEditExtraForm.getFieldsValue()?.form_extra };
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
      invEditExtraForm.resetFields();
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
            <Select allowClear placeholder="按状态筛选" className="ui-control-width-inventory" value={status} options={statusOptions ?? []} onChange={(value) => { setStatus(value); setPage(1); }} />
            <Select allowClear placeholder="按业务筛选" className="ui-control-width-inventory" value={businessMode} options={businessOptions ?? []} onChange={(value) => { setBusinessMode(value); setPage(1); }} />
            <Select allowClear placeholder="按类型筛选" className="ui-control-width-inventory" value={inventoryType} options={inventoryTypeOptions ?? []} onChange={(value) => { setInventoryType(value); setPage(1); }} />
            <Input
              allowClear
              value={keyword}
              placeholder="搜索账号 / 产品 / 平台"
              aria-label="搜索库存账号"
              className="ui-control-width-inventory"
              onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
            />
            <PermissionButton
              permission="report.read"
              aria-label="导出"
              icon={<DownloadOutlined />}
              loading={exporting}
              onClick={() => void handleExport()}
            >
              导出
            </PermissionButton>
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
      <Modal
        title="退款登记"
        open={Boolean(cancelTarget)}
        okText="确认退款并取消交易"
        cancelText="返回"
        confirmLoading={cancelling}
        onOk={() => refundForm.submit()}
        onCancel={() => { if (!cancelling) { setCancelTarget(null); refundForm.resetFields(); } }}
      >
        {cancelTarget ? <Form form={refundForm} layout="vertical" onFinish={(values) => void submitCancellation(values as { refund_amount: string; reason: string; form_extra?: Record<string, unknown> })}>
          <p className="muted">
            交易 {cancelTarget.account.source_order_no || "-"} 将按原售出流水和原资金池原路退款。
            {cancelTarget.account.inventory_type === "PICKUP" ? "提号取消后直接结束，不回库存。" : "取消后账号回到库存。"}
          </p>
          <FieldConfigScope scope="INVREFUND" active={Boolean(cancelTarget)}>
          <CfgItem name="refund_amount" label="退款金额" rules={requiredMoneyRules("退款金额")}>
            <MoneyInput aria-label="退款金额" inputMode="decimal" />
          </CfgItem>
          <CfgItem name="reason" label="退款原因" rules={[{ required: true, message: "请填写退款原因" }]}>
            <Input.TextArea aria-label="取消原因" rows={3} placeholder="请输入退款原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix="inv-refund" />
          </FieldConfigScope>
        </Form> : null}
      </Modal>
      <Modal
        title="下架登记"
        open={Boolean(voidTarget)}
        okText="确认下架"
        cancelText="返回"
        confirmLoading={voiding}
        okButtonProps={{ danger: true }}
        onOk={() => voidForm.submit()}
        onCancel={() => { if (!voiding) { setVoidTarget(null); voidForm.resetFields(); } }}
      >
        {voidTarget ? <Form form={voidForm} layout="vertical" onFinish={(values) => void submitVoid(values as { reason: string; form_extra?: Record<string, unknown> })}>
          <p className="muted">
            将按来源订单全额冲销该账号的买入流水（¥{money(voidTarget.amount)}），账号状态变为「下架」并退出在库统计；
            下架不可撤销，历史轨迹保留。
          </p>
          <FieldConfigScope scope="INVOID" active={Boolean(voidTarget)}>
          <CfgItem name="reason" label="下架原因" rules={[{ required: true, message: "请填写下架原因" }]}>
            <Input.TextArea aria-label="下架原因" rows={3} placeholder="请输入下架原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix="inv-void" />
          </FieldConfigScope>
        </Form> : null}
      </Modal>
      <Modal
        title="退款登记"
        open={Boolean(installmentCancelTarget)}
        okText="确认退款并终止分期"
        cancelText="返回"
        confirmLoading={cancellingInstallment}
        onOk={() => instCancelForm.submit()}
        onCancel={() => { if (!cancellingInstallment) { setInstallmentCancelTarget(null); instCancelForm.resetFields(); } }}
      >
        {installmentCancelTarget ? <Form form={instCancelForm} layout="vertical" onFinish={(values) => void submitInstallmentCancellation(values as { reason: string; form_extra?: Record<string, unknown> })}>
          <p className="muted">
            分期收款将按原资金池原路退款。
            {installmentCancelTarget.contractType === "PICKUP_SALE" ? "提号取消后账号直接结束。" : installmentCancelTarget.contractType === "ADVANCE_PURCHASE" ? "取消后终止分期合约。" : "取消后账号回到库存。"}
          </p>
          <FieldConfigScope scope="INVCANCEL" active={Boolean(installmentCancelTarget)}>
          <CfgItem name="reason" label="取消原因" rules={[{ required: true, message: "请填写退款原因" }]}>
            <Input.TextArea aria-label="分期取消原因" rows={3} placeholder="请输入退款及取消原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix="inv-cancel" />
          </FieldConfigScope>
        </Form> : null}
      </Modal>
      <Modal className="inventory-edit-modal" title="编辑账号及执行明细" open={Boolean(editingAccount)} width={1200} okText="保存修改" cancelText="取消" confirmLoading={savingAccount} okButtonProps={{ disabled: Boolean(editingAccount && executionLoading[editingAccount.id]) }} onOk={() => void saveInline()} onCancel={() => { if (!savingAccount) { setEditingAccount(null); setEventDrafts({}); invEditExtraForm.resetFields(); } }}>
        {editingAccount ? <>
          <div className="inventory-edit-core" aria-label="核心账号资料">
            <label>
              <span>账号标识</span>
              <Input aria-label="编辑账号标识" value={editingAccount.game_account ?? ""} onChange={(e) => setEditingAccount({ ...editingAccount, game_account: e.target.value })} />
            </label>
            <label>
              <span>产品</span>
              <Input aria-label="编辑产品" value={editingAccount.game_type ?? ""} onChange={(e) => setEditingAccount({ ...editingAccount, game_type: e.target.value })} />
            </label>
            <label>
              <span>平台</span>
              <Input aria-label="编辑平台" value={editingAccount.platform ?? ""} onChange={(e) => setEditingAccount({ ...editingAccount, platform: e.target.value })} />
            </label>
          </div>
          <Form form={invEditExtraForm} layout="vertical">
            <FieldConfigScope scope="INVEDIT" active={Boolean(editingAccount)}>
              <CustomFieldSection testIdSuffix="inv-edit" />
            </FieldConfigScope>
          </Form>
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

