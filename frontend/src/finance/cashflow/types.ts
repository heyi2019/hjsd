import type { Dayjs } from "dayjs";
import type { Account } from "../../shared/api/types/accounts";
import type { Pool } from "../../shared/api/types/finance";
import type { EmployeeOption } from "../../shared/api/types/org";

export type CashflowTarget = {
  orderId: number;
  orderNo: string;
  account?: Account;
  cashflows?: CashflowDisplayItem[];
};

export type CashflowDisplayItem = {
  flow_no: string;
  occurred_on: string;
  direction: string;
  amount: string;
  operator?: string | null;
};

export type CashflowFormValues = {
  occurred_on?: Dayjs | string;
  direction?: string;
  amount: string;
  pool_id?: number;
  note: string;
  operator_user_ids?: number[];
  form_extra?: Record<string, unknown>;
};

export type CashflowModalProps = {
  target: CashflowTarget | null;
  pools: Pool[];
  users?: EmployeeOption[];
  scope?: string;
  showOperator?: boolean;
  showDetails?: boolean;
  currentOperator?: string;
  onClose: () => void;
  /** 回调始终收到实际写入的订单，便于刷新对应详情。 */
  onCreated: (target: CashflowTarget) => void | Promise<void>;
};
