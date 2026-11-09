import { appMessage } from "../../shared/ui/appFeedback";
import { Dropdown, Form, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Key } from "react";
import { stocksApi, ordersApi, poolsApi, type Account, type AccountExecutionDetail, type InventoryStats, type Pool } from "../../shared/api/catalog";
import { isRequestAborted, normalizeError } from "../../shared/api/client";
import { formatDateTimeMinute, today } from "../../shared/lib/format";
import { MoneyText, PermissionButton, StatusTag } from "../../shared/ui";
import { consignmentRecords, type ActiveConsignment } from "../InventoryPlatformOffsaleModal";
import type { InventoryPartyLink } from "../../orders/orderedit";
import type { InventoryProfileTarget } from "../InventoryProfileModal";
import type { InventoryCancellationValues } from "../InventoryCancellationDialog";
import { BUSINESS_MODE_LABEL, INVENTORY_AGE_COLOR, INVENTORY_TYPE_LABEL, isEditableAccountType } from "../inventory-logic";
import { downloadInventoryCsv } from "../inventory-export";
import { useOptionSet } from "../../shared/lib/optionSets";
import { columnKey, useListViewColumns } from "../../shared/lib/listColumns";
import { useReloadOnActive } from "../../shared/state/reloadOnActive";
import { useSession } from "../../shared/state/session";
import type { BusinessCenterEntryTab } from "../../orders/businessCenter";
import { filterInventoryRows, findCancelableBuy, inventoryCellValue, moreMenuItems } from "./helpers";
import { useOrderEditor } from "../../orders/orderedit";

// 关键字逐键输入时合并请求：指标不是主流程，200ms 足够跟手。
const INVENTORY_STATS_DEBOUNCE_MS = 200;
const EXPORT_DETAIL_BATCH_SIZE = 500;

export function useInventoryController({ refreshKey = 0, active = true, onOrdersChanged, onNavigate }: { refreshKey?: number; active?: boolean; onOrdersChanged?: () => void; onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void }) {
  // 账号删除不可逆：按钮按系统角色显隐，后端仍做管理员二次鉴权。
  const { role } = useSession();
  const canDelete = role === "admin";
  const [rows, setRows] = useState<Account[]>([]);
  const [inventoryStats, setInventoryStats] = useState<InventoryStats | null>(null);
  const [businessMode, setBusinessMode] = useState<string | undefined>(undefined);
  const [inventoryType, setInventoryType] = useState<string | undefined>(undefined);
  const [inventoryStatus, setInventoryStatus] = useState<"WAITING" | "SOLD">("WAITING");
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
  const exportAbortRef = useRef<AbortController | null>(null);
  const locallyRemovedIdsRef = useRef(new Set<number>());
  useEffect(() => () => exportAbortRef.current?.abort(), []);
  const [profileTarget, setProfileTarget] = useState<InventoryProfileTarget | null>(null);
  const [detailTarget, setDetailTarget] = useState<Account | null>(null);
  const [voidTarget, setVoidTarget] = useState<{ account: Account; orderId: number; eventId: number; amount: string; portion: string } | null>(null);
  const [voidPools, setVoidPools] = useState<Pool[]>([]);
  const [platformOffsaleTarget, setPlatformOffsaleTarget] = useState<{ account: Account; records: ActiveConsignment[] } | null>(null);
  const [voiding, setVoiding] = useState(false);
  // 删除二次确认：target 非空即弹窗打开，deleting 控制防重与按钮 loading。
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [voidForm] = Form.useForm<InventoryCancellationValues>();
  // T20：筛选项从「选项词典」配置读取（库存业务 / 类型）。
  const businessOptions = useOptionSet("INVENTORY_BUSINESS");
  const inventoryTypeOptions = useOptionSet("INVENTORY_TYPE");
  const gameTypeOptions = useMemo(() => Array.from(new Set((rows ?? [])
    .map((row) => row.game_type)
    .filter((value): value is string => Boolean(value))))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((value) => ({ value, label: value })), [rows]);
  const load = useCallback(async (requestedStatus: "WAITING" | "SOLD" = inventoryStatus) => {
    try {
      const list = await stocksApi.list({ status: requestedStatus });
      const freshIds = new Set((list ?? []).map((row) => row.id));
      locallyRemovedIdsRef.current.forEach((id) => {
        if (!freshIds.has(id)) locallyRemovedIdsRef.current.delete(id);
      });
      setRows((list ?? []).filter((row) => !locallyRemovedIdsRef.current.has(row.id)));
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, [inventoryStatus]);

  function switchInventoryStatus(status: "WAITING" | "SOLD") {
    setInventoryStatus(status);
    setPage(1);
    void load(status);
  }

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
  // 当前表格只由 .ant-table-content 接管横向滚动；保留 body 作为兼容回退，避免 antd 版本差异造成失忆。
  const scrollLeftRef = useRef(0);
  function captureScroll() {
    const scrollRegion = document.querySelector<HTMLElement>(
      ".inventory-table--single-scroll .ant-table-content, .inventory-table--single-scroll .ant-table-body",
    );
    if (scrollRegion) scrollLeftRef.current = scrollRegion.scrollLeft;
  }
  function expandTo(ids: Key[]) {
    captureScroll();
    setExpandedAccountIds(ids);
  }
  useLayoutEffect(() => {
    const scrollRegion = document.querySelector<HTMLElement>(
      ".inventory-table--single-scroll .ant-table-content, .inventory-table--single-scroll .ant-table-body",
    );
    if (scrollRegion && scrollLeftRef.current) scrollRegion.scrollLeft = scrollLeftRef.current;
  }, [expandedAccountIds]);

  const inventoryRows = useMemo(
    () => filterInventoryRows(rows ?? [], { businessMode, gameType: gameTypeFilter, status: inventoryStatus }),
    [rows, businessMode, gameTypeFilter, inventoryStatus],
  );
  const inventoryTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of inventoryRows) {
      if (row.inventory_type) counts.set(row.inventory_type, (counts.get(row.inventory_type) ?? 0) + 1);
    }
    return counts;
  }, [inventoryRows]);
  const countInventoryRows = useCallback(
    (type?: string) => type ? (inventoryTypeCounts.get(type) ?? 0) : inventoryRows.length,
    [inventoryRows.length, inventoryTypeCounts],
  );
  const visibleRows = useMemo(() => filterInventoryRows(inventoryRows, {
    inventoryType,
    keyword,
    dateRange,
    status: inventoryStatus,
  }), [inventoryRows, inventoryType, keyword, dateRange, inventoryStatus]);
  // 展示排序：默认最新在前，可切换最旧在前（统计口径不受影响）。
  const orderedRows = useMemo(
    () => [...visibleRows].sort((a, b) => (sortDesc ? b.id - a.id : a.id - b.id)),
    [visibleRows, sortDesc],
  );
  // 卡片上的金额与库龄档位由后端按「当前可见集合」汇总：筛选只在前端做一份，
  // 算术只在后端做一份，避免 Number() 累加的浮点残渣与两套日期口径漂移。
  useEffect(() => {
    const accountIds = visibleRows.map((row) => row.id);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      stocksApi.inventoryStats(accountIds)
        .then((data) => {
          if (!cancelled && data) setInventoryStats(data);
        })
        // 指标是派生展示值，取不到就保留上一次结果，不打断台账主流程。
        .catch(() => undefined);
    }, INVENTORY_STATS_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [visibleRows]);

  function openProfile(account: Account, mode: InventoryProfileTarget["mode"]) {
    setProfileTarget({ account, mode });
  }

  const orderEditor = useOrderEditor({
    getExecutionDetail: (accountId) => executionDetails[accountId],
    onSaved: (accountId, detail) => {
      setExecutionDetails((current) => ({ ...current, [accountId]: detail }));
      setRows((current) => current.map((row) => row.id === accountId ? { ...row, ...detail.account } : row));
      setDetailTarget(null);
    },
  });

  async function openEditor(account: Account) {
    const detail = await loadExecution(account);
    await orderEditor.openEditor(account, detail);
    // 就地展开该行进入内联编辑（不弹窗）。
    expandTo([String(account.id)]);
  }

  function cancelInlineEdit() {
    orderEditor.cancelInlineEdit();
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
      // 取消会改订单/流水状态，同步通知上层重拉台账与分期列表。
      onOrdersChanged?.();
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setVoiding(false);
    }
  }

  /** 删除账号成功后重拉台账：订单已解绑，上层订单/分期视图也要同步刷新。 */
  async function submitDelete(reason: string) {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);
    try {
      await stocksApi.remove(target.id, reason);
      setDeleteTarget(null);
      dropExecutionCache(target.id);
      if (orderEditor.inlineEditId === target.id) cancelInlineEdit();
      expandTo(expandedAccountIds.filter((key) => String(key) !== String(target.id)));
      appMessage.success("账号已删除");
      await load();
      onOrdersChanged?.();
    } catch (cause) {
      // 失败时弹窗保持打开，用户可改原因后重试；错误必须出声，不能「点了没反应」。
      appMessage.error(normalizeError(cause).message);
    } finally {
      setDeleting(false);
    }
  }

  function handleMoreAction(key: string, row: Account) {
    if (key === "consignment") {
      setConsignmentTarget(row);
      return;
    }
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
      // 天数与档位都由后端下发（AccountOut.inventory_age_days / _level），
      // 此处不做任何日期减法，也不再按 7/30 天判色。
      render: (_value, row) => (
        row.inventory_age_days == null
          ? inventoryCellValue(null)
          : (
            <StatusTag
              status={row.status}
              color={row.inventory_age_level ? INVENTORY_AGE_COLOR[row.inventory_age_level] : undefined}
              label={`${row.inventory_age_days}天`}
            />
          )
      ),
    },
    { title: "状态", key: "status", dataIndex: "inventory_status", width: 68, render: (v: string | undefined, row) => <StatusTag status={v ?? (row.status === "WAITING" ? "IN_STOCK" : "OUT_OF_STOCK")} optionSet="INVENTORY_STATUS" /> },
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
      width: 292,
      className: "inventory-actions-col",
      onHeaderCell: () => ({ className: "inventory-actions-col" }),
      onCell: () => ({ className: "inventory-actions-col" }),
      render: (_value, row) => {
        const actionContextId = `inventory-action-context-${row.id}`;
        const recordLabel = row.game_account || row.source_order_no || `账号 #${row.id}`;
        return (
        <Space className="inventory-row-actions" size={4}>
          <span id={actionContextId} className="ui-visually-hidden">记录 {recordLabel}</span>
          <PermissionButton
            permission="order.create"
            type="link"
            size="small"
            aria-label="售出"
            aria-describedby={actionContextId}
            disabled={row.status !== 'WAITING'}
            onClick={(event) => {
              event.stopPropagation();
              setSaleTarget(row);
            }}
          >
            售出
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            type="link"
            size="small"
            aria-label="返点"
            aria-describedby={actionContextId}
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
              aria-describedby={actionContextId}
              disabled={orderEditor.editingAccount !== null}
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
                aria-describedby={actionContextId}
                onClick={(event) => event.stopPropagation()}
              >
                更多
              </PermissionButton>
            </Dropdown>
          </> : null}
          {canDelete ? <PermissionButton
            permission="order.create"
            type="link"
            size="small"
            danger
            aria-label="删除账号"
            aria-describedby={actionContextId}
            onClick={(event) => {
              event.stopPropagation();
              setDeleteTarget(row);
            }}
          >
            删除
          </PermissionButton> : null}
        </Space>
        );
      },
    },
  ];

  const mobileFieldOrder = arrangeColumns(columns).map(columnKey);

  async function handleExpand(expanded: boolean, row: Account) {
    // 手风琴：一次只展开一行。多行同时展开会各自挂载一份完整明细（3 张子表 + 图片组），DOM 与页面长度随之翻倍。
    if (!expanded && orderEditor.inlineEditId === row.id) cancelInlineEdit();
    expandTo(expanded ? [String(row.id)] : []);
    if (expanded) await loadExecution(row);
  }

  async function loadExecution(row: Account, force = false): Promise<AccountExecutionDetail | undefined> {
    if (!force && executionDetails[row.id]) return executionDetails[row.id];
    if (!force && executionLoading[row.id]) return undefined;
    setExecutionLoading((current) => ({ ...current, [row.id]: true }));
    try {
      const detail = await stocksApi.executionDetail(row.id);
      setExecutionDetails((current) => ({ ...current, [row.id]: detail }));
      return detail;
    } catch (err) {
      setError(normalizeError(err));
      return undefined;
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

  /** 售出成功后先从当前视图移除，避免库存列表在异步重拉期间继续展示已售账号。 */
  function removeFromInventory(accountId: number) {
    locallyRemovedIdsRef.current.add(accountId);
    setRows((current) => current.filter((row) => row.id !== accountId));
    setExpandedAccountIds((current) => current.filter((id) => String(id) !== String(accountId)));
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
    exportAbortRef.current?.abort();
    const abortController = new AbortController();
    exportAbortRef.current = abortController;
    setExporting(true);
    try {
      const cached = visibleRows.filter((row) => executionDetails[row.id]);
      const missingIds = visibleRows.filter((row) => !executionDetails[row.id]).map((row) => row.id);
      const fetchedDetails: Record<number, AccountExecutionDetail> = {};
      for (let start = 0; start < missingIds.length; start += EXPORT_DETAIL_BATCH_SIZE) {
        const batch = missingIds.slice(start, start + EXPORT_DETAIL_BATCH_SIZE);
        Object.assign(fetchedDetails, await stocksApi.executionDetailsBulk(batch, abortController.signal));
      }
      if (abortController.signal.aborted) return;
      setExecutionDetails((current) => ({ ...current, ...fetchedDetails }));
      const details = Object.fromEntries([
        ...cached.map((row) => [row.id, executionDetails[row.id]] as const),
        ...Object.entries(fetchedDetails),
      ]) as Partial<Record<number, AccountExecutionDetail>>;
      const failedCount = visibleRows.length - Object.keys(details).length;
      downloadInventoryCsv(visibleRows, details);
      if (failedCount) {
        appMessage.warning(`${failedCount} 条明细读取失败，已导出其余可用字段`);
      } else {
        appMessage.success("库存 CSV 已导出");
      }
    } catch (err) {
      if (!abortController.signal.aborted && !isRequestAborted(err)) throw err;
    } finally {
      if (exportAbortRef.current === abortController) exportAbortRef.current = null;
      setExporting(false);
    }
  }

  return {
    active,
    arrangeColumns,
    businessMode,
    businessOptions,
    canDelete,
    columns,
    consignmentTarget,
    countInventoryRows,
    dateRange,
    deleteTarget,
    deleting,
    detailTarget,
    dropExecutionCache,
    editingAccount: orderEditor.editingAccount,
    employees: orderEditor.employees,
    error,
    eventDrafts: orderEditor.eventDrafts,
    timeDrafts: orderEditor.timeDrafts,
    updateTimeDraft: orderEditor.updateTimeDraft,
    orderDrafts: orderEditor.orderDrafts,
    updateOrderDraft: orderEditor.updateOrderDraft,
    partyDrafts: orderEditor.partyDrafts,
    updatePartyDraft: orderEditor.updatePartyDraft,
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
    inventoryStatus,
    inventoryStatusOptions: [
      { value: "WAITING", label: "在库" },
      { value: "SOLD", label: "已售" },
    ],
    inlineEditId: orderEditor.inlineEditId,
    orderEditExtraForm: orderEditor.orderEditExtraForm,
    keyword,
    load,
    loadExecution,
    mobileFieldOrder,
    onNavigate,
    onOrdersChanged,
    removeFromInventory,
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
    savingAccount: orderEditor.savingAccount,
    setBusinessMode,
    setConsignmentTarget,
    setDeleteTarget,
    setDetailTarget,
    setDateRange,
    setEditingAccount: orderEditor.setEditingAccount,
    setExecutionDetails,
    setError,
    setGameTypeFilter,
    setInventoryType,
    setInventoryStatus: switchInventoryStatus,
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
    inventoryStats,
    updateEventDraft: orderEditor.updateEventDraft,
    voidForm,
    voidPools,
    voidTarget,
    voiding,
    cancelInlineEdit,
    saveInline: orderEditor.saveInline,
    submitDelete,
    submitVoid,
    visibleRows,
  };
}

export type InventoryController = ReturnType<typeof useInventoryController>;
