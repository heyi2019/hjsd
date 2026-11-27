import type { AccountExecutionEvent, AccountExecutionOrder, OrderDetailFinanceRow } from "../../../../shared/api/types/account-execution";
import type { FinanceDraft, OrderDraft } from "./editor-types";

export type ExecutionEventDraft = {
  id: number;
  expected_amount: string;
  amount: string;
  note: string | null;
  occurred_at: string;
  operator_user_ids?: number[];
  form_extra?: Record<string, unknown>;
};

export type ExecutionEventEdit = {
  id: number;
  expected_amount: string;
  amount: string;
  note: string | null;
  occurred_at?: string;
  operator_user_ids?: number[];
  form_extra?: Record<string, unknown>;
};

export type OperationEventCreateDraft = {
  occurred_at: string;
  form_extra: Record<string, unknown>;
  operator_user_ids?: number[];
  operation_type?: "IMAGE" | "DESCRIPTION" | "CONSIGNMENT" | "UNLIST";
};

export type ExecutionOperationCreate = {
  operation_type: "IMAGE" | "DESCRIPTION" | "CONSIGNMENT" | "UNLIST";
  occurred_at: string;
  form_extra?: Record<string, unknown>;
  operator_user_ids?: number[];
};

/** 只提交真正修改的订单字段，编辑交付信息时保留原备注和入库时间。 */
export function buildOrderEdits(
  orders: Array<Pick<AccountExecutionOrder, "order_id" | "created_at" | "occurred_at" | "note" | "extra_values">>,
  drafts: Record<number, OrderDraft>,
) {
  const originals = new Map(orders.map((order) => [order.order_id, order]));
  return Object.values(drafts).flatMap((draft) => {
    const original = originals.get(draft.order_id);
    if (!original) return [];
    const timeChanged = Boolean(draft.occurred_at && draft.occurred_at !== (original.occurred_at ?? original.created_at ?? ""));
    const noteChanged = draft.note !== (original.note ?? "");
    const hasExtra = Object.keys(draft.form_extra).length > 0;
    if (!timeChanged && !noteChanged && !hasExtra) return [];
    return [{
      order_id: draft.order_id,
      expected: {
        ...(timeChanged ? { occurred_at: original.occurred_at ?? original.created_at } : {}),
        ...(noteChanged ? { note: original.note ?? null } : {}),
        ...(hasExtra ? { form_extra: Object.fromEntries(Object.keys(draft.form_extra).map((key) => [key, original.extra_values?.[key] ?? null])) } : {}),
      },
      ...(timeChanged ? { occurred_at: draft.occurred_at } : {}),
      ...(noteChanged ? { note: draft.note } : {}),
      ...(hasExtra ? { form_extra: draft.form_extra } : {}),
    }];
  });
}

export function buildOperationEventCreates(
  drafts: Record<string, OperationEventCreateDraft>,
): ExecutionOperationCreate[] {
  return Object.values(drafts).filter((draft) => Boolean(draft.operation_type && (draft.occurred_at || Object.keys(draft.form_extra).length || draft.operator_user_ids?.length))).map((draft) => {
    if (!draft.occurred_at) throw new Error("请填写运营动作时间");
    return {
      operation_type: draft.operation_type!,
      occurred_at: draft.occurred_at,
      ...(Object.keys(draft.form_extra).length ? { form_extra: draft.form_extra } : {}),
      ...(draft.operator_user_ids !== undefined ? { operator_user_ids: draft.operator_user_ids } : {}),
    };
  });
}

function sameOperators(left?: number[] | null, right?: number[]) {
  if (right === undefined) return true;
  return JSON.stringify(left ?? []) === JSON.stringify(right);
}

export function buildEventEdits(
  events: Array<Pick<AccountExecutionEvent, "id" | "amount" | "note" | "occurred_at" | "operator_user_ids" | "form_extra">>,
  drafts: Record<number, ExecutionEventDraft>,
): ExecutionEventEdit[] {
  const originals = new Map<number, (typeof events)[number]>();
  for (const event of events) {
    const id = event.id;
    if (!Number.isNaN(id) && !originals.has(id)) originals.set(id, event);
  }
  return Object.values(drafts).filter((draft) => {
    const original = originals.get(draft.id);
    return Boolean(original && (
      draft.amount !== original.amount
      || draft.note !== (original.note ?? null)
      || draft.occurred_at !== (original.occurred_at ?? "")
      || draft.operator_user_ids !== undefined
        && !sameOperators(original.operator_user_ids, draft.operator_user_ids)
      || draft.form_extra !== undefined
        && JSON.stringify(original.form_extra ?? {}) !== JSON.stringify(draft.form_extra)
    ));
  }).map((draft) => ({
    id: draft.id,
    expected_amount: draft.expected_amount,
    amount: draft.amount,
    note: draft.note,
    ...(draft.occurred_at && draft.occurred_at !== (originals.get(draft.id)?.occurred_at ?? "") ? { occurred_at: draft.occurred_at } : {}),
    ...(draft.operator_user_ids !== undefined ? { operator_user_ids: draft.operator_user_ids } : {}),
    ...(draft.form_extra !== undefined ? { form_extra: draft.form_extra } : {}),
  }));
}

export function buildFinanceEdits(
  rows: Array<Pick<OrderDetailFinanceRow, "flow_no" | "amount" | "pool_id" | "occurred_at" | "note" | "operator_user_ids">>,
  drafts: Record<string, FinanceDraft>,
) {
  const originals = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const flowNo = row.flow_no;
    if (!originals.has(flowNo)) originals.set(flowNo, row);
  }
  return Object.values(drafts).filter((draft) => {
    const original = originals.get(draft.flow_no);
    return original && (
      draft.amount !== undefined && draft.amount !== original.amount
      || draft.pool_id !== undefined && draft.pool_id !== original.pool_id
      || draft.occurred_at !== (original.occurred_at ?? "")
      || draft.note !== (original.note ?? "")
      || draft.operator_user_ids !== undefined
        && JSON.stringify(draft.operator_user_ids) !== JSON.stringify(original.operator_user_ids ?? [])
    );
  }).map((draft) => ({
    flow_no: draft.flow_no,
    ...(draft.amount !== undefined ? { amount: draft.amount } : {}),
    ...(draft.pool_id !== undefined ? { pool_id: draft.pool_id } : {}),
    ...(draft.occurred_at ? { occurred_at: draft.occurred_at } : {}),
    note: draft.note,
    ...(draft.operator_user_ids !== undefined ? { operator_user_ids: draft.operator_user_ids } : {}),
  }));
}
