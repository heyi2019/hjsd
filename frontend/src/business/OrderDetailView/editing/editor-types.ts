import type { Form } from "antd";
import type { ExecutionEventDraft } from "./execution-edit-payload";
import type { OrderOperationDraft } from "../OrderDetail.shared";
import type { AccountExecutionEvent } from "../../../shared/api/types/account-execution";
import type { Account } from "../../../shared/api/types/accounts";
import type { EmployeeOption } from "../../../shared/api/types/org";
import type { Pool } from "../../../shared/api/types/finance";

export type EventDraft = ExecutionEventDraft;
export type OperationDraft = OrderOperationDraft;
export type FinanceDraft = {
  flow_no: string;
  amount?: string;
  pool_id?: number;
  occurred_at: string;
  note: string;
  operator_user_ids?: number[];
};
export type OrderDraft = {
  order_id: number;
  occurred_at: string;
  note: string;
  form_extra: Record<string, unknown>;
};

export type PartyAddition = {
  entity_type: "customer" | "counterparty";
  entity_id: number;
  role: string;
  operation?: "add" | "remove";
};

export interface OrderDetailEditor {
  editingAccount: Account | null;
  inlineEditId: number | null;
  eventDrafts: Record<number, EventDraft>;
  updateEventDraft: (event: AccountExecutionEvent, changes: { amount?: string; note?: string | null; occurred_at?: string; form_extra?: Record<string, unknown>; operator_user_ids?: number[] }) => void;
  operationDrafts: Partial<Record<string, OperationDraft>>;
  updateOperationDraft: (key: string, changes: Partial<OperationDraft>) => void;
  addOperationDraft: (operationType: NonNullable<OperationDraft["operation_type"]>) => void;
  removeOperationDraft: (key: string) => void;
  financeDrafts: Record<string, FinanceDraft>;
  updateFinanceDraft: (flowNo: string, changes: Partial<Omit<FinanceDraft, "flow_no">>) => void;
  updateEditingAccount: (changes: Partial<Account>) => void;
  orderDrafts: Record<number, OrderDraft>;
  updateOrderDraft: (orderId: number, changes: Partial<Omit<OrderDraft, "order_id">>) => void;
  partyDrafts: Record<number, PartyAddition[]>;
  updatePartyDraft: (orderId: number, addition: PartyAddition) => void;
  employees: EmployeeOption[];
  pools: Pool[];
  ensureEmployees: () => Promise<EmployeeOption[]>;
  invEditExtraForm: ReturnType<typeof Form.useForm>[0];
  savingAccount: boolean;
  openEditor: (account: Account, isCurrent?: () => boolean) => Promise<boolean>;
  cancelPendingOpen: () => void;
  isSaving: () => boolean;
  cancelInlineEdit: () => void;
  saveInline: () => Promise<void>;
}
