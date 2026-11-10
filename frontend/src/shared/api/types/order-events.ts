/** 订单事件、审计、附件与关联单（含记账结果）。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface OrderAuditEntry {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string;
  actor: string;
  reason?: string | null;
  request_id?: string | null;
  occurred_at: string;
}

export interface OrderAttachment {
  id: number;
  attachment_no: string;
  entity_type: string;
  entity_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  deleted_at?: string | null;
  created_at: string;
}

export interface OrderEvent {
  id: number;
  event_no: string;
  order_id: number;
  event_type: string;
  sale_mode?: "FULL" | "INSTALLMENT" | null;
  operation_type?: "IMAGE" | "DESCRIPTION" | "CONSIGNMENT" | "UNLIST" | null;
  rebate_type?: "BUY" | "SELL" | null;
  profit_recipient?: "BUY" | "SELL" | "OPERATION" | "COMPANY" | null;
  amount: string;
  occurred_on: string;
  pool_id?: number | null;
  portion?: string;
  delivery_mode?: string | null;
  delivery_direction?: "BUY" | "SELL" | null;
  offset_event_id?: number | null;
  reason?: string | null;
  operator_user_ids?: number[] | null;
  note?: string | null;
  form_extra?: Record<string, unknown> | null;
  is_posted: boolean;
  posted_at?: string | null;
  operator?: string;
  /** 该事件还能被冲销多少（amount − Σ已冲销 CANCEL，夹底 0；CANCEL 自身为 0），后端下发。 */
  cancellable_amount: string;
}

export interface OrderLink {
  id: number;
  source_order_id: number;
  source_order_no: string;
  target_order_id: number;
  target_order_no: string;
  relation_type: string;
  /** 以当前订单视角给出方向：outgoing=本单是来源单，incoming=本单是后续单。 */
  direction: string;
  split_ratio?: string | null;
  split_amount?: string | null;
  note?: string | null;
  created_at?: string;
}

export interface EventPostResult {
  event: OrderEvent;
  cashflow_no: string | null;
}
