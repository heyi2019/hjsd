import { appMessage } from "../../../shared/ui/appFeedback";
import { Form } from "antd";
import dayjs from "dayjs";
import { useState, type Key, type Dispatch, type SetStateAction } from "react";
import { employeesApi } from "../../../shared/api/org.api";
import { ordersApi } from "../../../shared/api/orders.api";
import { poolsApi } from "../../../shared/api/pools.api";
import type { AccountExecutionDetail } from "../../../shared/api/types/account-execution";
import type { Account } from "../../../shared/api/types/accounts";
import type { Pool } from "../../../shared/api/types/finance";
import { normalizeError } from "../../../shared/api/client";
import { today } from "../../../shared/lib/format";
import { consignmentRecords, type ActiveConsignment } from "../../operations";
import { type OrderPartyLink } from "../../OrderDetailView/OrderDetail.shared";
import { type OrderProfileTarget } from "../../operations";
import { type InventoryCancellationValues } from "../InventoryCancellationDialog";
import { type BusinessCenterEntryTab } from "../../businessCenter";
import { findCancelableBuy, type InventoryActionKey } from "./helpers";
import type { InventoryOrderRow } from "./types";
import { buildCashflowDisplayItems, type CashflowTarget } from "../../../finance/cashflow";
import type { EmployeeOption } from "../../../shared/api/types/org";

export function useInventoryActions(params: {
  // list 域注入
  load: () => Promise<void>;
  setRows: Dispatch<SetStateAction<InventoryOrderRow[]>>;
  setError: Dispatch<SetStateAction<{ message: string; code?: string } | null>>;
  // cache 域注入
  executionDetails: Record<number, AccountExecutionDetail>;
  setExecutionDetails: Dispatch<SetStateAction<Record<number, AccountExecutionDetail>>>;
  loadExecution: (row: Account, force?: boolean) => Promise<void>;
  loadOrderExecution: (orderId: number, force?: boolean) => Promise<AccountExecutionDetail | null>;
  loadEditorExecution: (row: Account, orderId: number) => Promise<AccountExecutionDetail | null>;
  dropExecutionCache: (accountId: number) => void;
  expandTo: (ids: Key[]) => void;
  expandedOrderIds: Key[];
  removeFromInventory: (accountId: number, orderId?: number) => void;
  // editor 域注入（本地 openEditor/cancelInlineEdit 会再包装一层）
  editorOpenEditor: (account: Account) => Promise<void>;
  editorCancelInlineEdit: () => void;
  inlineEditId: number | null;
  // 上层回调
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
}) {
  const {
    load, setRows, setError,
    executionDetails, setExecutionDetails, loadExecution, loadOrderExecution, loadEditorExecution, dropExecutionCache,
    expandTo, expandedOrderIds, removeFromInventory,
    editorOpenEditor, editorCancelInlineEdit, inlineEditId,
    onNavigate,
  } = params;
  const [saleTarget, setSaleTarget] = useState<Account | null>(null);
  const [consignmentTarget, setConsignmentTarget] = useState<Account | null>(null);
  const [rebateTarget, setRebateTarget] = useState<Account | null>(null);
  const [cashflowTarget, setCashflowTarget] = useState<CashflowTarget | null>(null);
  const [cashflowPools, setCashflowPools] = useState<Pool[]>([]);
  const [cashflowUsers, setCashflowUsers] = useState<EmployeeOption[]>([]);
  const [profileTarget, setProfileTarget] = useState<OrderProfileTarget | null>(null);
  const [detailTarget, setDetailTarget] = useState<Account | null>(null);
  const [voidTarget, setVoidTarget] = useState<{ account: Account; orderId: number; eventId?: number; amount: string; portion: string } | null>(null);
  const [voidPools, setVoidPools] = useState<Pool[]>([]);
  const [platformOffsaleTarget, setPlatformOffsaleTarget] = useState<{ account: Account; records: ActiveConsignment[] } | null>(null);
  const [voiding, setVoiding] = useState(false);
  // 删除二次确认：target 非空即弹窗打开，deleting 控制防重与按钮 loading。
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [voidForm] = Form.useForm<InventoryCancellationValues>();
  function openProfile(account: Account, mode: OrderProfileTarget["mode"]) {
    setProfileTarget({ account, mode });
  }
  async function openEditor(account: Account, orderId?: number) {
    const boundOrderId = orderId ?? account.source_order_id;
    if (boundOrderId == null) {
      appMessage.warning("当前账号没有绑定来源订单，无法编辑");
      return;
    }
    const detail = await loadEditorExecution(account, boundOrderId);
    if (!detail) return;
    await editorOpenEditor(detail.account);
    // 就地展开该行进入内联编辑（不弹窗）。
    // DataTable 的行键同时包含订单和账号：同一订单可能拆成多条库存行，展开键必须使用同一复合键。
    expandTo([`${boundOrderId}:${detail.account.id}`]);
  }
  function cancelInlineEdit() {
    editorCancelInlineEdit();
    setDetailTarget(null);
  }
  async function openDetail(account: Account) {
    await loadExecution(account);
    setDetailTarget(account);
  }
  async function openCashflow(account: Account) {
    if (account.source_order_id == null) {
      appMessage.warning("当前账号没有绑定来源订单，无法登记资金收支");
      return;
    }
    try {
      const [detail, poolList, employeeList] = await Promise.all([
        executionDetails[account.id] ?? ordersApi.executionDetail(account.source_order_id),
        poolsApi.list(),
        employeesApi.list(),
      ]);
      setExecutionDetails((current) => ({ ...current, [account.id]: detail }));
      const sourceOrder = detail.orders.find((order) => order.order_id === account.source_order_id);
      if (!sourceOrder) {
        appMessage.warning("当前账号没有可关联的业务订单");
        return;
      }
      setCashflowPools(poolList.filter((pool) => pool.status === "ACTIVE"));
      setCashflowUsers(employeeList.filter((employee) => employee.is_active));
      setCashflowTarget({
        account,
        orderId: sourceOrder.order_id,
        orderNo: sourceOrder.order_no,
        cashflows: buildCashflowDisplayItems(
          sourceOrder.cashflows ?? [],
          sourceOrder.events.flatMap((event) => event.cashflow ? [event.cashflow] : []),
        ),
      });
    } catch (cause) {
      setError(normalizeError(cause));
    }
  }
  async function openVoid(account: Account) {
    if (account.source_order_id == null) {
      appMessage.warning("当前账号没有绑定来源订单，无法取消交易");
      return;
    }
    try {
      const [detail, poolList] = await Promise.all([
        executionDetails[account.id] ?? ordersApi.executionDetail(account.source_order_id),
        poolsApi.list(),
      ]);
      setExecutionDetails((current) => ({ ...current, [account.id]: detail }));
      setVoidPools(poolList.filter((pool) => pool.status === "ACTIVE"));
      const buy = findCancelableBuy(detail);
      setVoidTarget({ account, ...(buy ?? { orderId: account.source_order_id, amount: "0.00", portion: "PRINCIPAL" }) });
      voidForm.setFieldsValue({ amount: buy?.amount ?? "0.00", pool_id: undefined, reason: undefined });
    } catch (cause) {
      setError(normalizeError(cause));
    }
  }
  async function openPlatformOffsale(account: Account) {
    if (account.source_order_id == null) {
      appMessage.warning("当前账号没有绑定来源订单，无法下架寄售记录");
      return;
    }
    try {
      const detail = executionDetails[account.id] ?? await ordersApi.executionDetail(account.source_order_id);
      setExecutionDetails((current) => ({ ...current, [account.id]: detail }));
      const records = consignmentRecords(detail.orders);
      if (!records.length && account.inventory_type !== "CONSIGNMENT") {
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
      const payload = {
        amount: values.amount,
        occurred_on: today(),
        ...(Number(values.amount) > 0 ? { pool_id: Number(values.pool_id) } : {}),
        portion: voidTarget.portion,
        ...(voidTarget.eventId != null && Number(values.amount) > 0 ? { offset_event_id: voidTarget.eventId } : {}),
        reason: values.reason.trim(),
        form_extra: values.form_extra,
      };
      await ordersApi.inventoryOffsale(voidTarget.orderId, { ...payload, unlisted_at: dayjs().format("YYYY-MM-DDTHH:mm") });
      appMessage.success("入库已取消，账号已退出库存");
      dropExecutionCache(voidTarget.account.id);
      setVoidTarget(null);
      voidForm.resetFields();
      // 先关闭提交弹窗，再后台刷新库存。
      void load();
      // 取消会改订单/流水状态，同步通知上层重拉台账与分期列表。
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setVoiding(false);
    }
  }
  /** 删除成功后重拉台账：关联订单已清理，上层订单/分期视图也要同步刷新。 */
  async function submitDelete(reason: string) {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const sourceOrderId = target.source_order_id;
    if (sourceOrderId == null) {
      appMessage.error("当前库存没有关联订单，无法删除");
      return;
    }
    setDeleting(true);
    try {
      await ordersApi.deleteOrder(sourceOrderId, reason);
      setDeleteTarget(null);
      dropExecutionCache(target.id);
      if (inlineEditId === target.id) cancelInlineEdit();
      expandTo(expandedOrderIds.filter((key) => String(key) !== String(target.source_order_id)));
      appMessage.success("已删除");
      await load();
    } catch (cause) {
      // 失败时弹窗保持打开，用户可改原因后重试；错误必须出声，不能「点了没反应」。
      appMessage.error(normalizeError(cause).message);
    } finally {
      setDeleting(false);
    }
  }
  function handleInventoryAction(key: InventoryActionKey, row: Account) {
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
  async function handleExpand(expanded: boolean, row: InventoryOrderRow) {
    // 手风琴：一次只展开一行。展开详情严格按订单 ID 请求；账号仅用于资料编辑和动作适配。
    if (!expanded && inlineEditId === row.account.id) cancelInlineEdit();
    expandTo(expanded ? [`${row.id}:${row.account.id}`] : []);
    if (expanded) await loadOrderExecution(row.id);
  }
  function openPartyCard(party: OrderPartyLink) {
    const param = party.entityType === "customer" ? `customer_id=${party.id}` : `counterparty_id=${party.id}`;
    onNavigate?.(`customers?${param}`);
  }

  return {
    saleTarget,
    setSaleTarget,
    consignmentTarget,
    setConsignmentTarget,
    rebateTarget,
    setRebateTarget,
    cashflowTarget,
    setCashflowTarget,
    cashflowPools,
    cashflowUsers,
    profileTarget,
    setProfileTarget,
    detailTarget,
    setDetailTarget,
    voidTarget,
    setVoidTarget,
    voidPools,
    voidForm,
    voiding,
    submitVoid,
    platformOffsaleTarget,
    setPlatformOffsaleTarget,
    deleteTarget,
    setDeleteTarget,
    deleting,
    submitDelete,
    openProfile,
    openEditor,
    cancelInlineEdit,
    openDetail,
    openVoid,
    openPlatformOffsale,
    handleInventoryAction,
    handleExpand,
    openPartyCard,
    openCashflow,
  };
}
