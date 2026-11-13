import { appMessage } from "../../shared/ui/appFeedback";
import { Form } from "antd";
import { useState, type Key, type Dispatch, type SetStateAction } from "react";
import { ordersApi } from "../../shared/api/orders.api";
import { unlistAndCancelConsignmentOrders } from "../operations";
import { employeesApi } from "../../shared/api/org.api";
import { poolsApi } from "../../shared/api/pools.api";
import { stocksApi } from "../../shared/api/stocks.api";
import type { AccountExecutionDetail } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import type { Pool } from "../../shared/api/types/finance";
import type { EmployeeOption } from "../../shared/api/types/org";
import { normalizeError } from "../../shared/api/client";
import { today } from "../../shared/lib/format";
import { consignmentRecords, type ActiveConsignment } from "../operations";
import { type InventoryPartyLink } from "../OrderDetail.shared";
import { type InventoryProfileTarget } from "../operations";
import { type InventoryCancellationValues } from "../InventoryCancellationDialog";
import { type BusinessCenterEntryTab } from "../../orders/businessCenter";
import { findCancelableBuy } from "./helpers";
import type { CashflowTarget } from "../../finance/cashflow";
import { type OrderDeliveryTarget } from "../../orders/OrderDeliveryModal";

export function useInventoryActions(params: {
  // list 域注入
  load: () => Promise<void>;
  setRows: Dispatch<SetStateAction<Account[]>>;
  setError: Dispatch<SetStateAction<{ message: string; code?: string } | null>>;
  // cache 域注入
  executionDetails: Record<number, AccountExecutionDetail>;
  setExecutionDetails: Dispatch<SetStateAction<Record<number, AccountExecutionDetail>>>;
  loadExecution: (row: Account, force?: boolean) => Promise<void>;
  dropExecutionCache: (accountId: number) => void;
  expandTo: (ids: Key[]) => void;
  expandedAccountIds: Key[];
  setExpandedAccountIds: Dispatch<SetStateAction<Key[]>>;
  removeFromInventory: (accountId: number) => void;
  // editor 域注入（本地 openEditor/cancelInlineEdit 会再包装一层）
  editorOpenEditor: (account: Account) => Promise<void>;
  editorCancelInlineEdit: () => void;
  inlineEditId: number | null;
  // 上层回调
  onOrdersChanged?: () => void;
  onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void;
}) {
  const {
    load, setRows, setError,
    executionDetails, setExecutionDetails, loadExecution, dropExecutionCache,
    expandTo, expandedAccountIds, setExpandedAccountIds, removeFromInventory,
    editorOpenEditor, editorCancelInlineEdit, inlineEditId,
    onOrdersChanged, onNavigate,
  } = params;
  const [saleTarget, setSaleTarget] = useState<Account | null>(null);
  const [consignmentTarget, setConsignmentTarget] = useState<Account | null>(null);
  const [rebateTarget, setRebateTarget] = useState<Account | null>(null);
  const [cashflowTarget, setCashflowTarget] = useState<CashflowTarget | null>(null);
  const [cashflowPools, setCashflowPools] = useState<Pool[]>([]);
  const [deliveryTarget, setDeliveryTarget] = useState<OrderDeliveryTarget | null>(null);
  const [deliveryEmployees, setDeliveryEmployees] = useState<EmployeeOption[]>([]);
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
  function openProfile(account: Account, mode: InventoryProfileTarget["mode"]) {
    setProfileTarget({ account, mode });
  }
  async function openEditor(account: Account) {
    await loadExecution(account);
    await editorOpenEditor(account);
    // 就地展开该行进入内联编辑（不弹窗）。
    expandTo([String(account.id)]);
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
    try {
      const [detail, poolList] = await Promise.all([
        executionDetails[account.id] ?? stocksApi.executionDetail(account.id),
        poolsApi.list(),
      ]);
      setExecutionDetails((current) => ({ ...current, [account.id]: detail }));
      const sourceOrder = detail.orders.find((order) => order.order_id === account.source_order_id)
        ?? detail.orders.find((order) => order.order_type !== "DG")
        ?? detail.orders[0];
      if (!sourceOrder) {
        appMessage.warning("当前账号没有可关联的业务订单");
        return;
      }
      setCashflowPools(poolList.filter((pool) => pool.status === "ACTIVE"));
      setCashflowTarget({ account, orderId: sourceOrder.order_id, orderNo: sourceOrder.order_no });
    } catch (cause) {
      setError(normalizeError(cause));
    }
  }
  async function openDelivery(account: Account) {
    try {
      const [detail, employeeList] = await Promise.all([
        executionDetails[account.id] ?? stocksApi.executionDetail(account.id),
        employeesApi.list(),
      ]);
      setExecutionDetails((current) => ({ ...current, [account.id]: detail }));
      const sourceOrder = detail.orders.find((order) => order.order_id === account.source_order_id)
        ?? detail.orders.find((order) => order.order_type !== "DG")
        ?? detail.orders[0];
      if (!sourceOrder) {
        appMessage.warning("当前账号没有可关联的业务订单");
        return;
      }
      const direction: "BUY" | "SELL" = sourceOrder.order_type === "DG"
        || sourceOrder.events.some((event) => event.event_type === "SELL")
        ? "SELL"
        : "BUY";
      const alreadyDelivered = sourceOrder.events.some(
        (event) => event.event_type === "DELIVER"
          && event.delivery_direction === direction,
      );
      if (alreadyDelivered) {
        appMessage.warning(`${direction === "BUY" ? "买号" : "卖号"}交付已经登记`);
        return;
      }
      setDeliveryEmployees(employeeList.filter((employee) => employee.is_active));
      setDeliveryTarget({
        orderId: sourceOrder.order_id,
        orderNo: sourceOrder.order_no,
        direction,
        boundPhone: detail.account.bound_phone,
        boundPhoneOwner: detail.account.bound_phone_owner,
      });
    } catch (cause) {
      setError(normalizeError(cause));
    }
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
      // 系统下架先在原订单上登记所有寄售记录的 UNLIST，再冲销买入，
      // 避免出现 ERP 已下架但平台记录仍有效的中间结果。
      const detail = executionDetails[voidTarget.account.id] ?? await stocksApi.executionDetail(voidTarget.account.id);
      const records = consignmentRecords(detail.orders);
      await unlistAndCancelConsignmentOrders({
        records,
        note: "系统下架同步取消寄售平台上架",
        reason: "系统下架同步取消寄售平台上架",
        occurredOn: today(),
      });
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
  /** 删除库存成功后重拉台账：关联订单已清理，上层订单/分期视图也要同步刷新。 */
  async function submitDelete(reason: string) {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);
    try {
      await stocksApi.remove(target.id, reason);
      setDeleteTarget(null);
      dropExecutionCache(target.id);
      if (inlineEditId === target.id) cancelInlineEdit();
      expandTo(expandedAccountIds.filter((key) => String(key) !== String(target.id)));
      appMessage.success("库存已删除");
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
  async function handleExpand(expanded: boolean, row: Account) {
    // 手风琴：一次只展开一行。多行同时展开会各自挂载一份完整明细（3 张子表 + 图片组），DOM 与页面长度随之翻倍。
    if (!expanded && inlineEditId === row.id) cancelInlineEdit();
    expandTo(expanded ? [String(row.id)] : []);
    if (expanded) await loadExecution(row);
  }
  function openPartyCard(party: InventoryPartyLink) {
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
    deliveryTarget,
    setDeliveryTarget,
    deliveryEmployees,
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
    openDelivery,
    openVoid,
    openPlatformOffsale,
    handleMoreAction,
    handleExpand,
    openPartyCard,
    openCashflow,
  };
}
