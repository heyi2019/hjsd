import type { AccountExecutionEvent } from "../../../shared/api/types/account-execution";

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
  return Object.values(drafts).filter((draft) => {
    const original = events.find((event) => event.id === draft.id);
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
    ...(draft.occurred_at ? { occurred_at: draft.occurred_at } : {}),
    ...(draft.operator_user_ids !== undefined ? { operator_user_ids: draft.operator_user_ids } : {}),
    ...(draft.form_extra !== undefined ? { form_extra: draft.form_extra } : {}),
  }));
}
