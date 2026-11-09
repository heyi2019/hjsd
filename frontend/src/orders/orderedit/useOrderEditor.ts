import { Form } from "antd";
import { useState, type Dispatch, type SetStateAction } from "react";
import {
  stocksApi,
  ordersApi,
  employeesApi,
  type Account,
  type AccountExecutionDetail,
  type AccountExecutionEvent,
  type EmployeeOption,
} from "../../shared/api/catalog";
import type { InventoryOrderDraft, InventoryPartyDraft } from "./OrderDetail.shared";
import { normalizeError } from "../../shared/api/client";
import { appMessage } from "../../shared/ui/appFeedback";

export type EventDraft = {
  id: number;
  expected_amount: string;
  amount: string;
  note: string | null;
  occurred_at?: string | null;
  flow_occurred_at?: string | null;
  operator_user_ids?: number[];
};

export interface OrderEditor {
  editingAccount: Account | null;
  setEditingAccount: Dispatch<SetStateAction<Account | null>>;
  inlineEditId: number | null;
  eventDrafts: Record<number, EventDraft>;
  updateEventDraft: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; occurred_at?: string | null; flow_occurred_at?: string | null; operator_user_ids?: number[] }) => void;
  timeDrafts: { registered_at?: string | null; sold_at?: string | null };
  updateTimeDraft: (key: "registered_at" | "sold_at", value: string | null) => void;
  orderDrafts: Record<number, InventoryOrderDraft>;
  updateOrderDraft: (orderId: number, changes: InventoryOrderDraft) => void;
  partyDrafts: Record<number, InventoryPartyDraft>;
  updatePartyDraft: (orderId: number, draft: InventoryPartyDraft) => void;
  employees: EmployeeOption[];
  ensureEmployees: () => Promise<void>;
  orderEditExtraForm: ReturnType<typeof Form.useForm>[0];
  savingAccount: boolean;
  openEditor: (account: Account, detail?: AccountExecutionDetail) => Promise<void>;
  cancelInlineEdit: () => void;
  saveInline: () => Promise<void>;
}
/**
 * 订单编辑功能板块状态机：把库存中心与订单中心共用的编辑逻辑抽出，
 * 保证两个入口（库存中心列表 / 订单中心台账）表现一致，且都面向同一份 stocks 记录、
 * 同一个后端接口（stocksApi.updateExecution / updateProfile），编辑后各自 re-fetch 即时反映。
 *
 * 详情缓存由各调用方注入（getExecutionDetail / onSaved），hook 自身不持有列表缓存，
 * 由库存中心与订单中心分别注入缓存结构。
 */
export function useOrderEditor(params: {
  getExecutionDetail: (accountId: number) => AccountExecutionDetail | undefined;
  onSaved: (accountId: number, detail: AccountExecutionDetail) => void;
}): OrderEditor {
  const { getExecutionDetail, onSaved } = params;
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [inlineEditId, setInlineEditId] = useState<number | null>(null);
  const [eventDrafts, setEventDrafts] = useState<Record<number, EventDraft>>({});
  const [timeDrafts, setTimeDrafts] = useState<{ registered_at?: string | null; sold_at?: string | null }>({});
  const [orderDrafts, setOrderDrafts] = useState<Record<number, InventoryOrderDraft>>({});
  const [partyDrafts, setPartyDrafts] = useState<Record<number, InventoryPartyDraft>>({});
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [orderEditExtraForm] = Form.useForm();
  const [savingAccount, setSavingAccount] = useState(false);

  async function ensureEmployees() {
    if (employees.length) return;
    try {
      setEmployees(await employeesApi.list());
    } catch {
      // 只读详情没有员工名单时保留占位文案；编辑态仍可在保存前重试。
    }
  }

  async function openEditor(account: Account, detail?: AccountExecutionDetail) {
    setEditingAccount({ ...account });
    setEventDrafts({});
    setOrderDrafts({});
    setPartyDrafts({});
    const source = detail?.orders?.[0];
    const sell = detail?.orders?.flatMap((order) => order.events).find((event) => event.event_type === "SELL");
    setTimeDrafts({
      registered_at: source?.created_at ?? account.created_at ?? null,
      sold_at: sell?.occurred_at ?? null,
    });
    await ensureEmployees();
    setInlineEditId(account.id);
  }

  function cancelInlineEdit() {
    setInlineEditId(null);
    setEditingAccount(null);
    setEventDrafts({});
    setTimeDrafts({});
    setOrderDrafts({});
    setPartyDrafts({});
    orderEditExtraForm.resetFields();
  }

  function updateEventDraft(event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; occurred_at?: string | null; flow_occurred_at?: string | null; operator_user_ids?: number[] }) {
    setEventDrafts((current) => ({
      ...current,
      [event.id]: {
        ...(current[event.id] ?? { id: event.id, expected_amount: event.amount, amount: event.amount, note: event.note ?? null }),
        ...changes,
      },
    }));
  }

  function updateTimeDraft(key: "registered_at" | "sold_at", value: string | null) {
    setTimeDrafts((current) => ({ ...current, [key]: value }));
  }

  function updateOrderDraft(orderId: number, changes: InventoryOrderDraft) {
    setOrderDrafts((current) => ({
      ...current,
      [orderId]: {
        ...current[orderId],
        ...changes,
        ...(changes.extra_values ? { extra_values: { ...(current[orderId]?.extra_values ?? {}), ...changes.extra_values } } : {}),
        ...(changes.form_extra ? { form_extra: { ...(current[orderId]?.form_extra ?? {}), ...changes.form_extra } } : {}),
      },
    }));
  }

  function updatePartyDraft(orderId: number, draft: InventoryPartyDraft) {
    setPartyDrafts((current) => ({ ...current, [orderId]: draft }));
  }

  async function saveInline() {
    if (!editingAccount) return;
    setSavingAccount(true);
    try {
      const {
        id,
        game_account,
        camp_account,
        game_type,
        game_password,
        channel_region,
        bound_phone,
        has_secondary,
        secondary_images,
        wallet_realname,
        wallet_realname_images,
        platform,
        account_description,
        account_images,
        note,
      } = editingAccount;
      const profile = {
        game_account,
        camp_account,
        game_type,
        game_password,
        channel_region,
        bound_phone,
        has_secondary,
        secondary_images,
        wallet_realname,
        wallet_realname_images,
        platform,
        account_description,
        account_images,
        note,
        form_extra: orderEditExtraForm.getFieldsValue()?.form_extra,
      };
      const detail = getExecutionDetail(id);
      const sourceOrder = detail?.orders?.[0];
      const sellEvent = detail?.orders?.flatMap((order) => order.events).find((event) => event.event_type === "SELL");
      const sameMinute = (left?: string | null, right?: string | null) => (left ?? null)?.replace(" ", "T").slice(0, 16) === (right ?? null)?.replace(" ", "T").slice(0, 16);
      const timeSet: { registered_at?: string | null; sold_at?: string | null } = {};
      if (timeDrafts.registered_at !== undefined && !sameMinute(timeDrafts.registered_at, sourceOrder?.created_at ?? editingAccount.created_at)) timeSet.registered_at = timeDrafts.registered_at;
      if (timeDrafts.sold_at !== undefined && !sameMinute(timeDrafts.sold_at, sellEvent?.occurred_at)) timeSet.sold_at = timeDrafts.sold_at;
      const events = Object.values(eventDrafts).filter((draft) => {
        const original = detail?.orders.flatMap((order) => order.events).find((event) => event.id === draft.id);
        return original && (draft.amount !== original.amount || draft.note !== (original.note ?? null) || draft.occurred_at !== undefined || draft.flow_occurred_at !== undefined || draft.operator_user_ids !== undefined);
      });
      const orderChanges = Object.entries(orderDrafts).filter(([, draft]) => Object.keys(draft).length);
      for (const [orderId, draft] of orderChanges) {
        await ordersApi.patch(Number(orderId), draft);
      }
      for (const [orderId, draft] of Object.entries(partyDrafts)) {
        await ordersApi.replaceParticipants(Number(orderId), draft);
      }
      if (events.length) {
        await stocksApi.updateExecution(id, {
          profile,
          events,
          ...(Object.keys(timeSet).length ? { time_set: timeSet } : {}),
        });
        setEditingAccount(null);
        setEventDrafts({});
        setInlineEditId(null);
        try {
          const detail = await stocksApi.executionDetail(id);
          onSaved(id, detail);
        } catch (refreshError) {
          appMessage.warning("修改已保存，但刷新明细失败，请重新加载");
          console.warn("reload execution detail after save failed", normalizeError(refreshError).message);
        }
      } else {
        const updated = Object.keys(timeSet).length
          ? await stocksApi.updateExecution(id, { profile, events: [], time_set: timeSet })
          : await stocksApi.updateProfile(id, profile);
        try {
          const detail = await stocksApi.executionDetail(id);
          onSaved(id, detail);
        } catch {
          // 保存前详情必然已加载（用户已展开并进入编辑），prev 不会缺失；
          // 兜底只在不击穿地刷新账号字段，不构造残缺 detail，避免丢失 finance_summary 等。
          const prev = getExecutionDetail(id);
          if (prev) onSaved(id, { ...prev, account: { ...prev.account, ...updated } });
        }
      }
      setEditingAccount(null);
      setEventDrafts({});
      setTimeDrafts({});
      setOrderDrafts({});
      setPartyDrafts({});
      orderEditExtraForm.resetFields();
      setInlineEditId(null);
      appMessage.success("修改已保存");
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setSavingAccount(false);
    }
  }

  return {
    editingAccount,
    setEditingAccount,
    inlineEditId,
    eventDrafts,
    updateEventDraft,
    timeDrafts,
    updateTimeDraft,
    orderDrafts,
    updateOrderDraft,
    partyDrafts,
    updatePartyDraft,
    employees,
    ensureEmployees,
    orderEditExtraForm,
    savingAccount,
    openEditor,
    cancelInlineEdit,
    saveInline,
  };
}
