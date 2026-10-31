import { appMessage } from "../shared/ui/appFeedback";
/** 库存：以账号为载体的状态与成本（ACC-01 / RPT-01-01）。回收、提号、代挂账号从这里追踪。 */
import { DownloadOutlined } from "@ant-design/icons";
import { Card, Dropdown, Form, Input, Segmented, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Key } from "react";
import { stocksApi, employeesApi, ordersApi, type Account, type AccountExecutionDetail, type AccountExecutionEvent, type EmployeeOption } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { money, today } from "../shared/lib/format";
import { DataTable,
  BusinessActionModal,
  BusinessForm,
  ErrorBanner,
  MoneyText,
  PermissionButton,
  Select,
  StatRow,
  StatusTag,
  useCompactLayout, } from "../shared/ui";
import { InventorySaleModal } from "./InventorySaleModal";
import { InventoryConsignmentModal } from "./InventoryConsignmentModal";
import { InventoryPlatformOffsaleModal, consignmentRecords, type ActiveConsignment } from "./InventoryPlatformOffsaleModal";
import { InventoryRebateModal } from "./InventoryRebateModal";
import { OrderDetail } from "./OrderDetail";
import type { InventoryPartyLink } from "./OrderDetailView";
import { InventoryProfileModal, type InventoryProfileTarget } from "./InventoryProfileModal";
import "./InventoryPanel.css";
import { BUSINESS_MODE_LABEL,
  INVENTORY_TYPE_LABEL,
  VALUE_ADDED_SERVICE_LABEL,
  inventoryAge,
  isEditableAccountType, } from "./inventory-logic";
import { downloadInventoryCsv } from "./inventory-export";
import { useOptionSet } from "../shared/lib/optionSets";
import { useListViewColumns } from "../shared/lib/listColumns";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../orders/ConfigurableField";
import type { BusinessCenterEntryTab } from "../orders/businessCenter";

function inventoryCellValue(value: string | null | undefined) {
  return value ? value : <span className="inventory-empty-cell">-</span>;
}

/** 「更多」下拉的菜单项单一事实源：只返回当前可执行的操作，灰色禁用项直接隐藏。 */
function moreMenuItems(row: Account, detail?: AccountExecutionDetail) {
  const canPlatformOffsale = row.status !== "SOLD" && row.status !== "VOID";
  const canSystemOffsale = row.inventory_type === "CONSIGNMENT" && canPlatformOffsale;
  const hasActiveConsignment = Boolean(detail?.orders.some((order) => order.order_type === "DG" && order.status !== "CANCELLED"));
  const items = [] as Array<{ key: string; label: string; danger?: boolean }>;
  if (canPlatformOffsale && (hasActiveConsignment || canSystemOffsale)) items.push({ key: "offsale", label: "下架" });
  if (row.status !== "SOLD") {
    items.push({ key: "description", label: "描述" }, { key: "images", label: "作图" });
  }
  return items;
}

/** 倒序取最近一条仍有余额可冲销的 BUY/SELL 事件（「先冲销最近的」为原语义，此处保持一致）。
 *  下架（VOID）走后端「全额冲销买入事件」路径：CANCEL offset=BUY 且全额消耗时账号转入 VOID
 *  （core/state_machine.py ACCOUNT_TRANSITIONS；orders/events.py _apply_account_effect）。
 *
 *  注：曾尝试把内部 filter 改为「按 offset_event_id 预聚合的 Map」，实测在真实数据规模
 *  （单账号 3 单 × 8 事件）下反而慢约 3%（Map 构建开销 > 小规模 filter），故保留直写。
 *  此处仅省去 [...].reverse() 的数组副本，改为倒序索引。 */
export function findCancelableEvent(detail: AccountExecutionDetail, eventType: "BUY" | "SELL") {
  for (let i = detail.orders.length - 1; i >= 0; i -= 1) {
    const order = detail.orders[i];
    for (let j = order.events.length - 1; j >= 0; j -= 1) {
      const event = order.events[j];
      if (event.event_type !== eventType) continue;
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
          poolId: event.pool_id ?? undefined,
        };
      }
    }
  }
  return null;
}

export const findCancelableSale = (detail: AccountExecutionDetail) => findCancelableEvent(detail, "SELL");
export const findCancelableBuy = (detail: AccountExecutionDetail) => findCancelableEvent(detail, "BUY");

/** 移动端（≤640px）库存卡片列表。桌面由 useCompactLayout 控制不挂载，故不影响桌面表格与单测。 */
export function MobileInventoryList({
  rows,
  onDetail,
  onSale,
  onConsign,
  onVoid,
  onRebate,
  onEdit,
  onMoreAction,
  executionDetails = {},
  onLoadExecution = () => undefined,
  editingAccount,
}: {
  rows: Account[];
  onDetail: (row: Account) => void;
  onSale: (row: Account) => void;
  onConsign: (row: Account) => void;
  onVoid: (row: Account) => void;
  onRebate: (row: Account) => void;
  onEdit: (row: Account) => void;
  onMoreAction: (key: string, row: Account) => void;
  executionDetails?: Record<number, AccountExecutionDetail>;
  onLoadExecution?: (row: Account) => void | Promise<void>;
  editingAccount: number | null;
}) {
  if (rows.length === 0) return <div className="data-mobile-empty">暂无账号</div>;
  return (
    <div className="data-mobile-list">
      {rows.map((row) => {
        const age = inventoryAge(row);
        return (
          <article key={row.id} className="data-mobile-card">
            <div className="data-mobile-card__topline">
              <span className="data-mobile-card__title">{row.stock_no || row.game_account || `账号 ${row.id}`}</span>
              <StatusTag status={row.status} label={row.status === "VOID" ? "下架" : undefined} />
            </div>
            <dl className="data-mobile-card__meta">
              <div><dt>游戏/产品类型</dt><dd>{row.game_type || "-"}</dd></div>
              <div><dt>游戏账号/产品</dt><dd>{row.game_account || "-"}</dd></div>
              <div><dt>订单号</dt><dd>{row.source_order_no || "-"}</dd></div>
              <div><dt>业务</dt><dd>{row.business_mode ? BUSINESS_MODE_LABEL[row.business_mode] ?? row.business_mode : "-"}</dd></div>
              <div><dt>业务类型</dt><dd>{row.inventory_type ? INVENTORY_TYPE_LABEL[row.inventory_type] ?? row.inventory_type : "-"}</dd></div>
              <div><dt>增值服务</dt><dd>{row.value_added_service ? VALUE_ADDED_SERVICE_LABEL[row.value_added_service] ?? row.value_added_service : "-"}</dd></div>
              <div><dt>平台</dt><dd>{row.platform || "-"}</dd></div>
              <div><dt>未售时长</dt><dd>{age ? `${age.days}天` : "-"}</dd></div>
              <div><dt>成本</dt><dd><MoneyText value={row.cost_amount} /></dd></div>
            </dl>
            <div className="data-mobile-card__actions">
              <PermissionButton permission="order.create" type="link" size="small" onClick={() => onDetail(row)}>详情</PermissionButton>
              <PermissionButton permission="order.create" type="link" size="small" disabled={row.status !== "IN_STOCK"} onClick={() => onSale(row)}>售出</PermissionButton>
              <PermissionButton permission="order.create" type="link" size="small" disabled={row.status === "SOLD"} onClick={() => onConsign(row)}>寄售</PermissionButton>
              <PermissionButton permission="order.event.post" type="link" size="small" onClick={() => onRebate(row)}>返点</PermissionButton>
              <PermissionButton permission="order.event.post" type="link" size="small" disabled={row.status === "SOLD" || row.status === "VOID"} onClick={() => onVoid(row)}>作废</PermissionButton>
              {isEditableAccountType(row.inventory_type) ? (
                <>
                  <PermissionButton permission="order.create" type="link" size="small" disabled={editingAccount !== null} onClick={() => onEdit(row)}>编辑</PermissionButton>
                  <Dropdown
                    trigger={["click"]}
                    placement="bottomRight"
                    onOpenChange={(open) => { if (open) void onLoadExecution(row); }}
                    menu={{
                      className: "inventory-more-menu",
                      items: moreMenuItems(row, executionDetails[row.id]),
                      onClick: ({ key }) => onMoreAction(key, row),
                    }}
                  >
                    <PermissionButton permission="order.create" type="link" size="small">更多</PermissionButton>
                  </Dropdown>
                </>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function InventoryPanel({ refreshKey = 0, onOrdersChanged, onNavigate }: { refreshKey?: number; onOrdersChanged?: () => void; onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void }) {
  const [rows, setRows] = useState<Account[]>([]);
  const [businessMode, setBusinessMode] = useState<string | undefined>(undefined);
  const [inventoryType, setInventoryType] = useState<string | undefined>(undefined);
  const [valueAddedService, setValueAddedService] = useState<string | undefined>(undefined);
  const [keyword, setKeyword] = useState("");
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
  const [platformOffsaleTarget, setPlatformOffsaleTarget] = useState<{ account: Account; records: ActiveConsignment[] } | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [voidForm] = Form.useForm();
  const [invEditExtraForm] = Form.useForm();
  const [eventDrafts, setEventDrafts] = useState<Record<number, { id: number; expected_amount: string; amount: string; note: string | null; operator_user_ids?: number[] }>>({});
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  // T20：筛选项从「选项词典」配置读取（库存状态 / 业务 / 类型 / 增值服务）。
  const businessOptions = useOptionSet("INVENTORY_BUSINESS");
  const inventoryTypeOptions = useOptionSet("INVENTORY_TYPE");
  const valueAddedOptions = useOptionSet("VALUE_ADDED_SERVICE");
  const load = useCallback(async () => {
    try {
      const list = await stocksApi.list({ status: "IN_STOCK" });
      setRows(list ?? []);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
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

  const visibleRows = (rows ?? []).filter((row) => {
    const matchesStatus = row.status === "IN_STOCK";
    const matchesBusiness = !businessMode || row.business_mode === businessMode;
    const matchesType = !inventoryType || row.inventory_type === inventoryType;
    const matchesValueAdded = !valueAddedService || row.value_added_service === valueAddedService;
    const text = [row.game_account, row.game_type, row.channel_region, row.platform]
      .filter(Boolean).join(" ").toLowerCase();
    const matchesKeyword = !keyword.trim() || text.includes(keyword.trim().toLowerCase());
    return matchesStatus && matchesBusiness && matchesType && matchesValueAdded && matchesKeyword;
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
      const detail = executionDetails[account.id] ?? await stocksApi.executionDetail(account.id);
      setExecutionDetails((current) => ({ ...current, [account.id]: detail }));
      const buy = findCancelableBuy(detail);
      if (!buy) {
        appMessage.warning("未找到可冲销的买入流水，无法下架");
        return;
      }
      setVoidTarget({ account, ...buy });
      voidForm.setFieldsValue({ reason: undefined });
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

  async function submitVoid(values: { reason: string; form_extra?: Record<string, unknown> }) {
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
        amount: voidTarget.amount,
        occurred_on: today(),
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
      await load();
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
    { title: "订单号", dataIndex: "source_order_no", width: 80, ellipsis: true, render: (v: string | null) => inventoryCellValue(v) },
    { title: "业务", dataIndex: "business_mode", width: 56, ellipsis: true, render: (v: string | null) => v ? BUSINESS_MODE_LABEL[v] ?? v : inventoryCellValue(v)},
    { title: "业务类型", dataIndex: "inventory_type", width: 68, ellipsis: true, render: (v: string | null) => v ? INVENTORY_TYPE_LABEL[v] ?? v : inventoryCellValue(v) },
    {
      title: "增值服务",
      dataIndex: "value_added_service",
      width: 64,
      ellipsis: true,

      render: (v: string | null) => v ? VALUE_ADDED_SERVICE_LABEL[v] ?? v : inventoryCellValue(v),
    },
    { title: "平台", dataIndex: "platform", width: 60, ellipsis: true, render: (v: string | null) => inventoryCellValue(v)},
    {
      title: "未售时长",
      width: 68,

      key: "inventoryAge",
      render: (_value, row) => {
        const age = inventoryAge(row);
        return age ? <StatusTag status={row.status} color={age.color} label={`${age.days}天`} /> : inventoryCellValue(null);
      },
    },
    { title: "状态", dataIndex: "status", width: 68, render: (v: string) => <StatusTag status={v} label={v === "VOID" ? "下架" : undefined} /> },
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
            aria-label="返点"
            onClick={(event) => {
              event.stopPropagation();
              setRebateTarget(row);
            }}
          >
            返点
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            type="link"
            size="small"
            aria-label="作废"
            disabled={row.status === "SOLD" || row.status === "VOID"}
            onClick={(event) => {
              event.stopPropagation();
              void openVoid(row);
            }}
          >
            作废
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
          { label: "在库账号", kind: "count", amount: String(visibleOccupied.length) },
          { label: "占用成本合计", amount: totalCost },
        ]}
      />

      <Card
        className="glass"
        title="账号台账"
        extra={
          <Space wrap>
            <Select allowClear placeholder="按业务筛选" className="ui-control-width-inventory" value={businessMode} options={businessOptions ?? []} onChange={(value) => { setBusinessMode(value); setPage(1); }} />
            <Select allowClear placeholder="按类型筛选" className="ui-control-width-inventory" value={inventoryType} options={inventoryTypeOptions ?? []} onChange={(value) => { setInventoryType(value); setPage(1); }} />
            <Select allowClear placeholder="按增值服务筛选" className="ui-control-width-inventory" value={valueAddedService} options={valueAddedOptions ?? []} onChange={(value) => { setValueAddedService(value); setPage(1); }} />
            <Input
              allowClear
              value={keyword}
              placeholder="搜索游戏账号/产品 / 游戏/产品类型 / 平台"
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
            <Space size={8}>
              <Typography.Text type="secondary">排序</Typography.Text>
              <Segmented
                aria-label="库存排序"
                value={sortDesc ? "desc" : "asc"}
                options={[
                  { value: "desc", label: "最新在前" },
                  { value: "asc", label: "最旧在前" },
                ]}
                onChange={(value) => { setSortDesc(value === "desc"); setPage(1); }}
              />
            </Space>
          </Space>
        }
      >
        {compact ? (
          <MobileInventoryList
            rows={orderedRows}
            onDetail={(row) => void openDetail(row)}
            onSale={setSaleTarget}
            onConsign={setConsignmentTarget}
            onVoid={(row) => void openVoid(row)}
            onRebate={setRebateTarget}
            onEdit={openEditor}
            onMoreAction={handleMoreAction}
            executionDetails={executionDetails}
            onLoadExecution={loadExecution}
            editingAccount={editingAccount ? editingAccount.id : null}
          />
        ) : (
          <DataTable<Account>
            // key 绑定展开集：antd 受控 expandedRowKeys 在「换一行展开」时不回收旧行的展开区
            // （实测：极简 antd Table 同样复现；换 record 引用、分两步 setState 均无效），
            // 必须以重建 Table 的方式让旧展开行真正卸载，手风琴才成立。
            // 已知代价：展开/收起会重建表格，横向滚动位置回零。
            key={`account-ledger-${expandedAccountIds.join("|")}`}
            className="inventory-table"
            columns={arrangeColumns(columns)}
            rows={orderedRows}
            page={page}
            pageSize={pageSize}
            total={visibleRows.length}
            controlledPaging
          
            expandable={{
              expandedRowKeys: expandedAccountIds,
              expandedRowRender: (row) => (
                <OrderDetail
                  row={row}
                  detail={executionDetails[row.id]}
                  loading={Boolean(executionLoading[row.id])}
                  onPartyClick={openPartyCard}
                  editing={inlineEditId === row.id ? editingAccount : undefined}
                  onEdit={setEditingAccount}
                  eventDrafts={eventDrafts}
                  onEventEdit={updateEventDraft}
                  employees={employees}
                  extraForm={invEditExtraForm}
                  onSave={saveInline}
                  onCancel={cancelInlineEdit}
                  saving={savingAccount}
                />
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
        )}
      </Card>

      <InventorySaleModal
        account={saleTarget}
        onClose={() => setSaleTarget(null)}
        onCreated={async () => {
          const account = saleTarget;
          setSaleTarget(null);
          await load();
          // 售出后账号离开在库列表，展开区已无承载方，只丢本地缓存即可（重拉纯属浪费请求）。
          if (account) dropExecutionCache(account.id);
          // 售出会在原买入订单上登记 SELL（不再新建订单），同步通知上层重拉台账，避免两边数据不同步。
          onOrdersChanged?.();
        }}
      />
      <InventoryConsignmentModal
        account={consignmentTarget}
        onClose={() => setConsignmentTarget(null)}
        onCreated={async () => {
          const account = consignmentTarget;
          setConsignmentTarget(null);
          await load();
          // 寄售后账号仍在库，展开区可能正展示它 —— 必须重拉，原逻辑是手动补写一次 detail，等价但这里统一由 refreshExecution 收口。
          if (account) refreshExecution(account);
          onOrdersChanged?.();
        }}
      />
      <InventoryRebateModal
        account={rebateTarget}
        onClose={() => setRebateTarget(null)}
        onCreated={async () => {
          const account = rebateTarget;
          setRebateTarget(null);
          await load();
          // 返点会新增一条资金流水，展开区「资金明细」必须同步，否则停在写前快照。
          if (account) refreshExecution(account);
          onOrdersChanged?.();
        }}
      />
      <BusinessActionModal size="compact"
        title="系统下架登记"
        open={Boolean(voidTarget)}
        okText="确认下架"
        cancelText="返回"
        confirmLoading={voiding}
        okButtonProps={{ danger: true }}
        onOk={() => voidForm.submit()}
        onCancel={() => { if (!voiding) { setVoidTarget(null); voidForm.resetFields(); } }}
      >
        {voidTarget ? <BusinessForm scope="INVOID" form={voidForm} onFinish={(values) => void submitVoid(values as { reason: string; form_extra?: Record<string, unknown> })}>
          <p className="muted">
            将按来源订单全额冲销该账号的买入流水（¥{money(voidTarget.amount)}），账号状态变为「下架」并退出在库统计；
            这是 ERP 系统下架，不影响已登记的寄售平台历史记录。下架不可撤销，历史轨迹保留。
          </p>
          <FieldConfigScope scope="INVOID" active={Boolean(voidTarget)}>
          <CfgItem name="reason" label="下架原因" rules={[{ required: true, message: "请填写下架原因" }]}>
            <Input.TextArea aria-label="下架原因" rows={3} placeholder="请输入下架原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix="inv-void" />
          </FieldConfigScope>
        </BusinessForm> : null}
      </BusinessActionModal>
      <InventoryPlatformOffsaleModal
        account={platformOffsaleTarget?.account ?? null}
        records={platformOffsaleTarget?.records ?? []}
        onClose={() => setPlatformOffsaleTarget(null)}
        onSystemOffsale={async ({ reason, form_extra }) => {
          const target = platformOffsaleTarget;
          setPlatformOffsaleTarget(null);
          if (!target || target.records.length === 0) return;
          try {
            await Promise.all(target.records.map((record) => ordersApi.cancel(record.orderId, {
              reason,
              form_extra_scope: "INVOID",
              form_extra: {
                ...form_extra,
                platform_unlist_scope: "SYSTEM",
                platform_unlisted_at: new Date().toISOString().slice(0, 16),
              },
            })));
            appMessage.success("代挂订单已取消，账号已出库");
            await load();
            // 取消代挂订单会改写 orders/events 状态，账号仍在库，展开区需重拉。
            refreshExecution(target.account);
            onOrdersChanged?.();
          } catch (cause) {
            setError(normalizeError(cause));
            await load();
          }
        }}
        onChanged={async () => {
          const accountId = platformOffsaleTarget?.account.id;
          setPlatformOffsaleTarget(null);
          if (!accountId) return;
          await load();
          const detail = await stocksApi.executionDetail(accountId);
          setExecutionDetails((current) => ({ ...current, [accountId]: detail }));
          onOrdersChanged?.();
        }}
      />
      <BusinessActionModal
        className="inventory-detail-modal"
        title={inlineEditId === detailTarget?.id ? "编辑账号" : "库存详情"}
        open={Boolean(detailTarget)}
        footer={null}
        width="min(1200px, calc(100vw - 24px))"
        onCancel={() => cancelInlineEdit()}
      >
        {detailTarget ? <OrderDetail
          row={detailTarget}
          detail={executionDetails[detailTarget.id]}
          loading={Boolean(executionLoading[detailTarget.id])}
          onPartyClick={openPartyCard}
          editing={inlineEditId === detailTarget.id ? editingAccount : undefined}
          onEdit={setEditingAccount}
          eventDrafts={eventDrafts}
          onEventEdit={updateEventDraft}
          employees={employees}
          extraForm={invEditExtraForm}
          onSave={saveInline}
          onCancel={cancelInlineEdit}
          saving={savingAccount}
        /> : null}
      </BusinessActionModal>
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

