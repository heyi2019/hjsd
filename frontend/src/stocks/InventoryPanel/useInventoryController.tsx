import { appMessage } from "../../shared/ui/appFeedback";
import { Dropdown, Form, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Key } from "react";
import { stocksApi, employeesApi, ordersApi, poolsApi, type Account, type AccountExecutionDetail, type AccountExecutionEvent, type EmployeeOption, type Pool } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { formatDateTimeMinute, money, today } from "../../shared/lib/format";
import { MoneyText, PermissionButton, PermissionGate, StatusTag, useCompactLayout } from "../../shared/ui";
import { InventoryPlatformOffsaleModal, consignmentRecords, type ActiveConsignment } from "../InventoryPlatformOffsaleModal";
import type { InventoryPartyLink } from "../OrderDetailView";
import type { InventoryProfileTarget } from "../InventoryProfileModal";
import type { InventoryCancellationValues } from "../InventoryCancellationDialog";
import { BUSINESS_MODE_LABEL, INVENTORY_TYPE_LABEL, inventoryAge, isEditableAccountType } from "../inventory-logic";
import { downloadInventoryCsv } from "../inventory-export";
import { useOptionSet } from "../../shared/lib/optionSets";
import { columnKey, useListViewColumns } from "../../shared/lib/listColumns";
import { useReloadOnActive } from "../../shared/state/reloadOnActive";
import type { BusinessCenterEntryTab } from "../../orders/businessCenter";
import { filterInventoryRows, findCancelableBuy, inventoryCellValue, moreMenuItems } from "./helpers";

export function useInventoryController({ refreshKey = 0, active = true, onOrdersChanged, onNavigate }: { refreshKey?: number; active?: boolean; onOrdersChanged?: () => void; onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void }) {
  const [rows, setRows] = useState<Account[]>([]);
  const [businessMode, setBusinessMode] = useState<string | undefined>(undefined);
  const [inventoryType, setInventoryType] = useState<string | undefined>(undefined);
  const [gameTypeFilter, setGameTypeFilter] = useState<string | undefined>(undefined);
  const [keyword, setKeyword] = useState("");
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [sortDesc, setSortDesc] = useState(true);
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
  // 内联编辑：标记当前正在编辑（且已展开）的行；与 editingAccount（草稿副本）配合，决定展开区是否进入编辑态。
  const [inlineEditId, setInlineEditId] = useState<number | null>(null);
  const [detailTarget, setDetailTarget] = useState<Account | null>(null);
  const compact = useCompactLayout();
  const [savingAccount, setSavingAccount] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{ account: Account; orderId: number; eventId: number; amount: string; portion: string } | null>(null);
  const [voidPools, setVoidPools] = useState<Pool[]>([]);
  const [platformOffsaleTarget, setPlatformOffsaleTarget] = useState<{ account: Account; records: ActiveConsignment[] } | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [voidForm] = Form.useForm<InventoryCancellationValues>();
  const [invEditExtraForm] = Form.useForm();
  const [eventDrafts, setEventDrafts] = useState<Record<number, { id: number; expected_amount: string; amount: string; note: string | null; operator_user_ids?: number[] }>>({});
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  // T20：筛选项从「选项词典」配置读取（库存业务 / 类型）。
  const businessOptions = useOptionSet("INVENTORY_BUSINESS");
  const inventoryTypeOptions = useOptionSet("INVENTORY_TYPE");
  const gameTypeOptions = Array.from(new Set((rows ?? [])
    .map((row) => row.game_type)
    .filter((value): value is string => Boolean(value))))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((value) => ({ value, label: value }));
  const load = useCallback(async () => {
    try {
      const list = await stocksApi.list({ status: "WAITING" });
      setRows(list ?? []);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useReloadOnActive(active, load);

  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === previousRefreshKey.current) return;
    previousRefreshKey.current = refreshKey;
    setPage(1);
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (refreshKey > 0) setPage(1);
  }, [refreshKey]);

  // 横向滚动记忆：手风琴展开/收起会以 key 重建整张 Table，旧滚动位置归零。
  // 展开前抓取 .ant-table-body 的 scrollLeft，重建后用 useLayoutEffect 还原（绘制前写回，无闪烁）。
  const scrollLeftRef = useRef(0);
  function captureScroll() {
    const body = document.querySelector<HTMLElement>(".inventory-table .ant-table-body");
    if (body) scrollLeftRef.current = body.scrollLeft;
  }
  function expandTo(ids: Key[]) {
    captureScroll();
    setExpandedAccountIds(ids);
  }
  useLayoutEffect(() => {
    const body = document.querySelector<HTMLElement>(".inventory-table .ant-table-body");
    if (body && scrollLeftRef.current) body.scrollLeft = scrollLeftRef.current;
  }, [expandedAccountIds]);

  const inventoryRows = filterInventoryRows(rows ?? [], { businessMode, gameType: gameTypeFilter });
  const countInventoryRows = (type?: string) => inventoryRows.filter((row) => !type || row.inventory_type === type).length;
  const visibleRows = filterInventoryRows(rows ?? [], {
    businessMode,
    inventoryType,
    gameType: gameTypeFilter,
    keyword,
    dateRange,
  });
  // 展示排序：默认最新在前，可切换最旧在前（统计口径不受影响）。
  const orderedRows = [...visibleRows].sort((a, b) => (sortDesc ? b.id - a.id : a.id - b.id));
  const visibleOccupied = visibleRows;
  const totalCost = visibleOccupied.reduce((sum, row) => sum + Number(row.cost_amount), 0).toFixed(2);

  function openProfile(account: Account, mode: InventoryProfileTarget["mode"]) {
    setProfileTarget({ account, mode });
  }

  async function openEditor(account: Account) {
    setEditingAccount({ ...account });
    setEventDrafts({});
    await Promise.all([
      employeesApi.list().then(setEmployees).catch((cause) => setError(normalizeError(cause))),
      loadExecution(account),
    ]);
    // 桌面：直接就地展开该行进入内联编辑（不弹窗）；移动端无内联表格，复用详情弹窗承载编辑态。
    if (compact) {
      setDetailTarget(account);
    } else {
      expandTo([String(account.id)]);
    }
    setInlineEditId(account.id);
  }

  function cancelInlineEdit() {
    setInlineEditId(null);
    setEditingAccount(null);
    setEventDrafts({});
    invEditExtraForm.resetFields();
    setDetailTarget(null);
  }

  async function openDetail(account: Account) {
    await loadExecution(account);
    setDetailTarget(account);
  }

  async function openVoid(account: Account) {
    try {
      const [detail, poolList] = await Promise.all([
        executionDetails[account.id] ?? stocksApi.executionDetail(account.id),
        poolsApi.list(),
      ]);
      setExecutionDetails((current) => ({ ...current, [account.id]: detail }));
      setVoidPools(poolList.filter((pool) => pool.status === "ACTIVE"));
      const buy = findCancelableBuy(detail);
      if (!buy) {
        appMessage.warning("未找到可冲销的买入流水，无法下架");
        return;
      }
      setVoidTarget({ account, ...buy });
      voidForm.setFieldsValue({ amount: buy.amount, pool_id: undefined, reason: undefined });
    } catch (cause) {
      setError(normalizeError(cause));
    }
  }

  async function openPlatformOffsale(account: Account) {
    try {
      const detail = executionDetails[account.id] ?? await stocksApi.executionDetail(account.id);
      setExecutionDetails((current) => ({ ...current, [account.id]: detail }));
      const records = consignmentRecords(detail.orders);
      if (!records.length) {
        appMessage.warning("当前账号没有仍在平台上的寄售记录");
        return;
      }
      setPlatformOffsaleTarget({ account, records });
    } catch (cause) {
      setError(normalizeError(cause));
    }
  }

  async function submitVoid(values: { amount: string; pool_id: number; reason: string; form_extra?: Record<string, unknown> }) {
    if (!voidTarget) return;
    setVoiding(true);
    try {
      // 系统下架会同步取消该账号所有仍在寄售平台上的 DG 上架单；
      // 先完成平台记录取消，再冲销买入，避免出现 ERP 已下架但平台记录仍有效的中间结果。
      const detail = executionDetails[voidTarget.account.id] ?? await stocksApi.executionDetail(voidTarget.account.id);
      await Promise.all(
        detail.orders
          .filter((order) => order.order_type === "DG" && order.status !== "CANCELLED")
          .map((order) => ordersApi.cancel(order.order_id, {
            reason: "系统下架同步取消寄售平台上架",
            form_extra_scope: "INVOID",
            form_extra: { platform_unlist_scope: "SYSTEM", platform_unlisted_at: new Date().toISOString().slice(0, 16) },
          })),
      );
      await ordersApi.postEvent(voidTarget.orderId, {
        event_type: "CANCEL",
        amount: values.amount,
        occurred_on: today(),
        pool_id: Number(values.pool_id),
        portion: voidTarget.portion,
        offset_event_id: voidTarget.eventId,
        reason: values.reason.trim(),
        form_extra: values.form_extra,
        note: "账号下架，冲销买入",
      });
      appMessage.success("账号已下架");
      // 下架后账号转 VOID 并退出在库统计，与售出同理，只丢缓存。
      dropExecutionCache(voidTarget.account.id);
      setVoidTarget(null);
      voidForm.resetFields();
      // 先关闭提交弹窗，再后台刷新库存；等待列表刷新会让确认按钮长期处于 loading，
      // 用户无法确认下架是否已经完成。
      void load();
      // 作废会改订单/流水状态，同步通知上层重拉台账与分期列表。
      onOrdersChanged?.();
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setVoiding(false);
    }
  }

  function handleMoreAction(key: string, row: Account) {
    if (key === "offsale") {
      void openPlatformOffsale(row);
      return;
    }
    if (key === "void") {
      void openVoid(row);
      return;
    }
    if (key === "description") {
      openProfile(row, "description");
      return;
    }
    if (key === "images") openProfile(row, "images");
  }

  const { arrange: arrangeColumns } = useListViewColumns("INVENTORY");
  const columns: ColumnsType<Account> = [
    { title: "库存编号", dataIndex: "stock_no", width: 86, ellipsis: true },
    { title: "游戏/产品类型", dataIndex: "game_type", width: 80, ellipsis: true, render: (v: string | null) => inventoryCellValue(v)},
    { title: "游戏账号/产品", dataIndex: "game_account", width: 120, ellipsis: true, render: (v: string | null) => inventoryCellValue(v) },
    { title: "营地账号", dataIndex: "camp_account", width: 120, ellipsis: true, render: (v: string | null) => inventoryCellValue(v) },
    { title: "订单号", dataIndex: "source_order_no", width: 80, ellipsis: true, render: (v: string | null) => inventoryCellValue(v) },
    { title: "入库时间", dataIndex: "inventory_entry_at", width: 132, ellipsis: true, render: (v: string | null) => formatDateTimeMinute(v) },
    { title: "入库负责人", dataIndex: "inventory_operator", width: 100, ellipsis: true, render: (v: string | null, row) => inventoryCellValue(v || row.created_by) },
    { title: "业务", dataIndex: "business_mode", width: 56, ellipsis: true, render: (v: string | null) => v ? BUSINESS_MODE_LABEL[v] ?? v : inventoryCellValue(v)},
    { title: "业务类型", dataIndex: "inventory_type", width: 68, ellipsis: true, render: (v: string | null) => v ? INVENTORY_TYPE_LABEL[v] ?? v : inventoryCellValue(v) },
    {
      title: "未售时长",
      width: 68,

      // key 必须与 scopes.py 的 ListColumn 注册（inventory_age）一致，
      // 否则 arrangeColumns 按 columnKey 匹配不到，隐藏/调序配置对它无效。
      key: "inventory_age",
      render: (_value, row) => {
        const age = inventoryAge(row);
        return age ? <StatusTag status={row.status} color={age.color} label={`${age.days}天`} /> : inventoryCellValue(null);
      },
    },
    { title: "状态", key: "status", dataIndex: "inventory_status", width: 68, render: (v: string | undefined, row) => <StatusTag status={v ?? (row.status === "WAITING" ? "IN_STOCK" : row.status)} label={row.status === "VOID" ? "下架" : undefined} /> },
    {
      title: "成本",
      dataIndex: "cost_amount",
      width: 90,
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "操作",
      key: "actions",
      width: 230,
      render: (_value, row) => (
        <Space className="inventory-row-actions" size={4}>
          <PermissionButton
            permission="order.create"
            type="link"
            size="small"
            aria-label="售出"
            disabled={row.status !== 'WAITING'}
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
            aria-label="返点"
            onClick={(event) => {
              event.stopPropagation();
              setRebateTarget(row);
            }}
          >
            返点
          </PermissionButton>
          {isEditableAccountType(row.inventory_type) ? <>
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
              onOpenChange={(open) => { if (open) void loadExecution(row); }}
              menu={{
                className: "inventory-more-menu",
                items: moreMenuItems(row, executionDetails[row.id]),
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
  const mobileFieldOrder = arrangeColumns(columns).map(columnKey);

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
        await stocksApi.updateExecution(id, { profile, events });
        setEditingAccount(null);
        setEventDrafts({});
        setInlineEditId(null);
        setDetailTarget(null);
        try {
          const detail = await stocksApi.executionDetail(id);
          setExecutionDetails((current) => ({ ...current, [id]: detail }));
          setRows((current) => current.map((row) => row.id === id ? { ...row, ...detail.account } : row));
        } catch (refreshError) {
          setExecutionDetails((current) => { const next = { ...current }; delete next[id]; return next; });
          setError(normalizeError(refreshError));
          appMessage.warning("修改已保存，但刷新明细失败，请重新加载");
        }
      } else {
        const updated = await stocksApi.updateProfile(id, profile);
        setRows((current) => current.map((row) => row.id === id ? { ...row, ...updated } : row));
      }
      setEditingAccount(null);
      setEventDrafts({});
      invEditExtraForm.resetFields();
      setInlineEditId(null);
      setDetailTarget(null);
      appMessage.success("修改已保存");
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
    // 手风琴：一次只展开一行。多行同时展开会各自挂载一份完整明细（3 张子表 + 图片组），DOM 与页面长度随之翻倍。
    if (!expanded && inlineEditId === row.id) cancelInlineEdit();
    expandTo(expanded ? [String(row.id)] : []);
    if (expanded) await loadExecution(row);
  }

  async function loadExecution(row: Account, force = false) {
    if (!force && (executionDetails[row.id] || executionLoading[row.id])) return;
    setExecutionLoading((current) => ({ ...current, [row.id]: true }));
    try {
      const detail = await stocksApi.executionDetail(row.id);
      setExecutionDetails((current) => ({ ...current, [row.id]: detail }));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setExecutionLoading((current) => ({ ...current, [row.id]: false }));
    }
  }

  /** 只丢弃详情缓存：用于账号已离开在库列表（售出/下架）的场景，重拉已无展示方，纯属浪费请求。 */
  function dropExecutionCache(accountId: number) {
    setExecutionDetails((current) => {
      if (!(accountId in current)) return current;
      const next = { ...current };
      delete next[accountId];
      return next;
    });
  }

  /** 写操作后让详情缓存失效并立即重拉，避免展开区停在写之前的快照。
   *  必须 force：此时 useState 尚未提交，闭包里的 executionDetails 仍是旧值，不加 force 会被命中缓存直接 return。 */
  function refreshExecution(row: Account) {
    dropExecutionCache(row.id);
    void loadExecution(row, true);
  }

  function openPartyCard(party: InventoryPartyLink) {
    const param = party.entityType === "customer" ? `customer_id=${party.id}` : `counterparty_id=${party.id}`;
    onNavigate?.(`customers?${param}`);
  }

  async function handleExport() {
    setExporting(true);
    try {
      const detailResults = await Promise.all(visibleRows.map(async (row) => {
        try {
          return [row.id, await stocksApi.executionDetail(row.id)] as const;
        } catch {
          return [row.id, undefined] as const;
        }
      }));
      const details = Object.fromEntries(detailResults) as Partial<Record<number, AccountExecutionDetail>>;
      const failedCount = detailResults.filter(([, detail]) => !detail).length;
      downloadInventoryCsv(visibleRows, details);
      if (failedCount) {
        appMessage.warning(`${failedCount} 条明细读取失败，已导出其余可用字段`);
      } else {
        appMessage.success("库存 CSV 已导出");
      }
    } finally {
      setExporting(false);
    }
  }

  return {
    active,
    arrangeColumns,
    businessMode,
    businessOptions,
    columns,
    compact,
    consignmentTarget,
    countInventoryRows,
    dateRange,
    detailTarget,
    dropExecutionCache,
    editingAccount,
    employees,
    error,
    eventDrafts,
    executionDetails,
    executionLoading,
    exporting,
    expandedAccountIds,
    gameTypeFilter,
    gameTypeOptions,
    handleExpand,
    handleExport,
    handleMoreAction,
    inventoryType,
    inventoryTypeOptions,
    inlineEditId,
    invEditExtraForm,
    keyword,
    load,
    loadExecution,
    mobileFieldOrder,
    onNavigate,
    onOrdersChanged,
    openDetail,
    openEditor,
    openPartyCard,
    openPlatformOffsale,
    openProfile,
    openVoid,
    orderedRows,
    page,
    pageSize,
    platformOffsaleTarget,
    profileTarget,
    rebateTarget,
    refreshExecution,
    rows,
    saleTarget,
    savingAccount,
    setBusinessMode,
    setConsignmentTarget,
    setDetailTarget,
    setDateRange,
    setEditingAccount,
    setExecutionDetails,
    setError,
    setGameTypeFilter,
    setInventoryType,
    setKeyword,
    setPage,
    setPageSize,
    setPlatformOffsaleTarget,
    setProfileTarget,
    setRebateTarget,
    setRows,
    setSaleTarget,
    setVoidTarget,
    setSortDesc,
    sortDesc,
    totalCost,
    updateEventDraft,
    voidForm,
    voidPools,
    voidTarget,
    voiding,
    cancelInlineEdit,
    saveInline,
    submitVoid,
    visibleRows,
  };
}

export type InventoryController = ReturnType<typeof useInventoryController>;
