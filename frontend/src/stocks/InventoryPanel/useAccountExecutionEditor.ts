import { Form } from "antd";
import { useState, type Dispatch, type SetStateAction } from "react";
import {
  stocksApi,
  employeesApi,
  type Account,
  type AccountExecutionDetail,
  type AccountExecutionEvent,
  type EmployeeOption,
} from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { appMessage } from "../../shared/ui/appFeedback";
import { type TimeFieldKey, type TimeSet } from "../OrderDetail.shared";

export type EventDraft = {
  id: number;
  expected_amount: string;
  amount: string;
  note: string | null;
  operator_user_ids?: number[];
};

export interface AccountExecutionEditor {
  editingAccount: Account | null;
  setEditingAccount: Dispatch<SetStateAction<Account | null>>;
  inlineEditId: number | null;
  eventDrafts: Record<number, EventDraft>;
  updateEventDraft: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) => void;
  timeSet: TimeSet;
  setTimeField: (field: TimeFieldKey, value: string | null) => void;
  employees: EmployeeOption[];
  invEditExtraForm: ReturnType<typeof Form.useForm>[0];
  savingAccount: boolean;
  openEditor: (account: Account) => Promise<void>;
  cancelInlineEdit: () => void;
  saveInline: () => Promise<void>;
}

/**
 * 账号执行详情编辑器状态机：把库存中心与订单中心共用的「账号台账内联编辑」逻辑抽出，
 * 保证两个入口（库存中心列表 / 订单中心台账）表现一致，且都面向同一份 stocks 记录、
 * 同一个后端接口（stocksApi.updateExecution / updateProfile），编辑后各自 re-fetch 即时反映。
 *
 * 详情缓存由各调用方注入（getExecutionDetail / onSaved），hook 自身不持有列表缓存，
 * 由库存中心与订单中心分别注入缓存结构。
 */
export function useAccountExecutionEditor(params: {
  getExecutionDetail: (accountId: number) => AccountExecutionDetail | undefined;
  onSaved: (accountId: number, detail: AccountExecutionDetail) => void;
}): AccountExecutionEditor {
  const { getExecutionDetail, onSaved } = params;
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [inlineEditId, setInlineEditId] = useState<number | null>(null);
  const [eventDrafts, setEventDrafts] = useState<Record<number, EventDraft>>({});
  const [timeSet, setTimeSet] = useState<TimeSet>({});
  const setTimeField = (field: TimeFieldKey, value: string | null) =>
    setTimeSet((current) => ({ ...current, [field]: value }));
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [invEditExtraForm] = Form.useForm();
  const [savingAccount, setSavingAccount] = useState(false);

  async function openEditor(account: Account) {
    setEditingAccount({ ...account });
    setEventDrafts({});
    setTimeSet({});
    try {
      const list = await employeesApi.list();
      setEmployees(list);
    } catch {
      // 员工列表加载失败不阻断编辑：事件操作人下拉可在保存前重试或留空由后端校验。
    }
    setInlineEditId(account.id);
  }

  function cancelInlineEdit() {
    setInlineEditId(null);
    setEditingAccount(null);
    setEventDrafts({});
    setTimeSet({});
    invEditExtraForm.resetFields();
  }

  function updateEventDraft(event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) {
    setEventDrafts((current) => ({
      ...current,
      [event.id]: {
        ...(current[event.id] ?? { id: event.id, expected_amount: event.amount, amount: event.amount, note: event.note ?? null }),
        ...changes,
      },
    }));
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
        form_extra: invEditExtraForm.getFieldsValue()?.form_extra,
      };
      const events = Object.values(eventDrafts).filter((draft) => {
        const original = getExecutionDetail(id)?.orders.flatMap((order) => order.events).find((event) => event.id === draft.id);
        return original && (draft.amount !== original.amount || draft.note !== (original.note ?? null) || draft.operator_user_ids !== undefined);
      });
      if (events.length || Object.keys(timeSet).length > 0) {
        const time_set = buildTimeSetPayload(timeSet);
        await stocksApi.updateExecution(id, {
          profile,
          events,
          time_set: time_set ?? undefined,
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
        const updated = await stocksApi.updateProfile(id, profile);
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
      setTimeSet({});
      invEditExtraForm.resetFields();
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
    timeSet,
    setTimeField,
    employees,
    invEditExtraForm,
    savingAccount,
    openEditor,
    cancelInlineEdit,
    saveInline,
  };
}

const TIME_SET_KEY_MAP: Record<TimeFieldKey, string> = {
  registeredAt: "registered_at",
  soldAt: "sold_at",
  flowAt: "flow_at",
};

/** 仅把「用户改过的字段」转成后端 time_set 载荷；未改的字段不发送。 */
function buildTimeSetPayload(set: TimeSet): Record<string, string | null> | null {
  const entries = Object.entries(set) as [TimeFieldKey, string | null][];
  if (entries.length === 0) return null;
  const payload: Record<string, string | null> = {};
  for (const [key, value] of entries) {
    payload[TIME_SET_KEY_MAP[key]] = value;
  }
  return payload;
}
