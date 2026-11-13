import { Form } from "antd";
import { useState, type Dispatch, type SetStateAction } from "react";
import { employeesApi } from "../../shared/api/org.api";
import { stocksApi } from "../../shared/api/stocks.api";
import type { AccountExecutionDetail, AccountExecutionEvent } from "../../shared/api/types/account-execution";
import type { Account } from "../../shared/api/types/accounts";
import type { EmployeeOption } from "../../shared/api/types/org";
import { normalizeError } from "../../shared/api/client";
import { appMessage } from "../../shared/ui/appFeedback";

export type EventDraft = {
  id: number;
  expected_amount: string;
  amount: string;
  note: string | null;
  operator_user_ids?: number[];
};

export interface AccountExecutionEditor {
  editingAccount: Account | null;
  inlineEditId: number | null;
  eventDrafts: Record<number, EventDraft>;
  updateEventDraft: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; operator_user_ids?: number[] }) => void;
  timeShiftMinutes: number;
  setTimeShiftDays: Dispatch<SetStateAction<number>>;
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
 * 库存中心与订单台账因此可以共用同一套编辑状态机，同时保留各自的列表筛选口径。
 */
export function useAccountExecutionEditor(params: {
  getExecutionDetail: (accountId: number) => AccountExecutionDetail | undefined;
  onSaved: (accountId: number, detail: AccountExecutionDetail) => void;
}): AccountExecutionEditor {
  const { getExecutionDetail, onSaved } = params;
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [inlineEditId, setInlineEditId] = useState<number | null>(null);
  const [eventDrafts, setEventDrafts] = useState<Record<number, EventDraft>>({});
  const [timeShiftMinutes, setTimeShiftDays] = useState(0);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [invEditExtraForm] = Form.useForm();
  const [savingAccount, setSavingAccount] = useState(false);

  async function openEditor(account: Account) {
    setEditingAccount({ ...account });
    setEventDrafts({});
    setTimeShiftDays(0);
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
    setTimeShiftDays(0);
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
        game_type,
        game_password,
        camp_account,
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
        game_type,
        game_password,
        camp_account,
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
      if (events.length || timeShiftMinutes !== 0) {
        await stocksApi.updateExecution(id, {
          profile,
          events,
          time_shift: timeShiftMinutes !== 0 ? { delta_minutes: timeShiftMinutes } : undefined,
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
      setTimeShiftDays(0);
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
    inlineEditId,
    eventDrafts,
    updateEventDraft,
    timeShiftMinutes,
    setTimeShiftDays,
    employees,
    invEditExtraForm,
    savingAccount,
    openEditor,
    cancelInlineEdit,
    saveInline,
  };
}
