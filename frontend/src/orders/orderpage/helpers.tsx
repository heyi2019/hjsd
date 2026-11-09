import type { Order } from "../../shared/api/catalog";
import type { OrderPatchPayload } from "../../shared/api/orders.api";
import type { Dayjs } from "dayjs";
import { money } from "../../shared/lib/format";

export type BusinessFilterKey = "all" | "HS" | "TH" | "DG";
export type BusinessModeFilterKey = "all" | "SELF" | "DISTRIBUTION";

export const BUSINESS_CREATE_ITEMS = [
  { key: "HS", label: "新建回收订单" },
  { key: "TH", label: "新建提号订单" },
  { key: "DG", label: "新建代挂订单" },
];

export type AllocationType = "BUY" | "SELL" | "OPERATION" | "COMPANY";

/** 分润录入口径：按人自由分配，或按操作四项（买号/售出/运营/公司）。 */
export type AllocationMode = "PERSON" | "ACTION";

export const ALLOCATION_TYPE_LABEL: Record<AllocationType, string> = {
  BUY: "买号",
  SELL: "售出",
  OPERATION: "运营",
  COMPANY: "公司",
};

export const ALLOCATION_TYPE_ROLE: Record<AllocationType, string> = {
  BUY: "BUYER",
  SELL: "SALES",
  OPERATION: "SERVICE",
  COMPANY: "OWNER",
};

/**
 * 按操作分润的录入口径：
 * - TOTAL：本行填的是「该动作合计」，提交时按该动作人数均分（多人动作只有首行是 TOTAL）
 * - SHARED：只读行，显示合计 ÷ 人数（同一动作的第 2 人及以后）
 * - PER_PERSON：本行就是某个人的实际值（单人动作、公司行、以及已有存量数据）
 */
export type AllocationShareMode = "TOTAL" | "SHARED" | "PER_PERSON";

export type AllocationFormRow = {
  employee?: number | number[] | "COMPANY";
  role?: string;
  allocation_type?: AllocationType | "";
  allocation_rate?: string;
  allocation_amount?: string;
  share_mode?: AllocationShareMode;
};

export type AllocationItem = {
  user_id: number | null;
  role: string;
  allocation_type?: AllocationType | null;
  allocation_rate: string;
  allocation_amount: string;
};

export type ActionAllocationCandidates = Record<AllocationType, number[]>;

export type AllocationValidation =
  | { ok: true; items: AllocationItem[] }
  | { ok: false; error: string };

function employeeIds(value: AllocationFormRow["employee"]): number[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0))];
}

function responsibleIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0))];
}

function postedEventOperatorIds(order: Pick<Order, "events">, eventTypes?: Set<string>): number[] {
  return [...new Set((order.events ?? [])
    .filter((event) => event.is_posted && (!eventTypes || eventTypes.has(event.event_type)))
    .flatMap((event) => responsibleIds(event.operator_user_ids)))];
}

/** 从订单事实提取四类动作负责人，作为按操作分润的默认人员与多人均分候选。 */
export function buildActionAllocationCandidates(order: Pick<Order, "events" | "form_extra">): ActionAllocationCandidates {
  const formExtra = order.form_extra ?? {};
  const businessResponsibleIds = responsibleIds(formExtra.business_responsible_ids);
  const deliveryResponsibleIds = responsibleIds(formExtra.delivery_responsible_ids);
  const operationResponsibleIds = responsibleIds(formExtra.operation_responsible_ids);
  const operationEventTypes = new Set((order.events ?? [])
    .map((event) => event.event_type)
    .filter((eventType) => !["BUY", "SELL", "CANCEL"].includes(eventType)));
  const operationEventOperatorIds = postedEventOperatorIds(order, operationEventTypes);
  return {
    BUY: businessResponsibleIds.length ? businessResponsibleIds : postedEventOperatorIds(order, new Set(["BUY"])),
    SELL: deliveryResponsibleIds.length ? deliveryResponsibleIds : postedEventOperatorIds(order, new Set(["SELL"])),
    OPERATION: operationResponsibleIds.length
      ? operationResponsibleIds
      : operationEventOperatorIds.length ? operationEventOperatorIds : businessResponsibleIds,
    COMPANY: [],
  };
}

/** 把一组行里某个字段的有效数值加起来；全是空值就返回空串（不猜、不换算）。 */
function sumRowValue(
  rows: Array<{ allocation_rate?: string; allocation_amount?: string }>,
  key: "allocation_rate" | "allocation_amount",
): string {
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const text = String(row[key] ?? "").trim();
    if (text === "") continue;
    const value = Number(text);
    if (!Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }
  return seen ? String(Number(total.toFixed(2))) : "";
}

/**
 * 按操作四项构建表单行。人员默认来自账号台账 / 库存中心登记的执行人，但可在分润弹窗中更换。
 * 一个动作登记了 N 位执行人时展开成 N 行：首行填「该动作合计」，其余行只读显示
 * 合计 ÷ N，提交时按人数均分（两人各半、三人各三分之一）。
 *
 * 一个动作只显示一行人员选择：可多选执行人，比例/金额填写该动作合计，提交时均分到所选人员。
 * 已有分润会合并为该动作合计；候选为空时沿用已有人员，避免打开弹窗时丢失存量数据。
 */
export function buildActionAllocationRows(
  items: Array<{
    allocation_type?: AllocationType | null;
    user_id?: number | null;
    role?: string;
    allocation_rate?: string;
    allocation_amount?: string;
  }>,
  candidates: ActionAllocationCandidates,
): AllocationFormRow[] {
  const order: AllocationType[] = ["BUY", "SELL", "OPERATION", "COMPANY"];
  const rows: AllocationFormRow[] = [];
  for (const kind of order) {
    const existed = items.filter((item) => item.allocation_type === kind);
    if (existed.length > 0) {
      const existedIds = [...new Set(existed.map((item) => item.user_id).filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0))];
      const selectedIds = kind === "COMPANY"
        ? []
        : (candidates[kind].length ? candidates[kind] : existedIds);
      rows.push({
        allocation_type: kind,
        employee: kind === "COMPANY" ? "COMPANY" : selectedIds.length ? selectedIds : undefined,
        role: existed[0]?.role || ALLOCATION_TYPE_ROLE[kind],
        allocation_rate: sumRowValue(existed, "allocation_rate"),
        allocation_amount: sumRowValue(existed, "allocation_amount"),
        share_mode: "TOTAL",
      });
      continue;
    }
    if (kind === "COMPANY") {
      rows.push({
        allocation_type: kind,
        employee: "COMPANY",
        role: ALLOCATION_TYPE_ROLE[kind],
        allocation_rate: "",
        allocation_amount: "",
        share_mode: "PER_PERSON",
      });
      continue;
    }
    const ids = candidates[kind];
    if (ids.length === 0) {
      rows.push({
        allocation_type: kind,
        employee: undefined,
        role: ALLOCATION_TYPE_ROLE[kind],
        allocation_rate: "",
        allocation_amount: "",
        share_mode: "TOTAL",
      });
      continue;
    }
    rows.push({
      allocation_type: kind,
      employee: ids.length ? ids : undefined,
      role: ALLOCATION_TYPE_ROLE[kind],
      allocation_rate: "",
      allocation_amount: "",
      share_mode: "TOTAL",
    });
  }
  return rows;
}

/** 把合计均分到 N 人：按分（金额）/ 0.01（比例）取整，余数给最后一人，保证各人之和等于合计。 */
export function splitEven(total: number, people: number, scale = 100): number[] {
  const units = Math.round(total * scale);
  const base = Math.trunc(units / people);
  const parts = Array.from({ length: people }, () => base);
  parts[people - 1] += units - base * people;
  return parts.map((unit) => unit / scale);
}

/** 分润输入联动：按订单利润把比例换算成金额，金额固定保留两位小数。 */
export function allocationAmountFromRate(orderProfit: string, rate: string): string {
  if (String(rate).trim() === "") return "";
  const profit = Number(orderProfit);
  const percentage = Number(rate);
  if (!Number.isFinite(profit) || !Number.isFinite(percentage)) return "";
  return (profit * percentage / 100).toFixed(2);
}

/** 分润输入联动：按订单利润把金额反算成比例；利润为 0 时没有可推导的比例。 */
export function allocationRateFromAmount(orderProfit: string, amount: string): string {
  if (String(amount).trim() === "") return "";
  const profit = Number(orderProfit);
  const value = Number(amount);
  if (!Number.isFinite(profit) || !Number.isFinite(value) || profit === 0) return "";
  return (value / profit * 100).toFixed(2);
}

export function validateAllocations(
  rows: AllocationFormRow[],
  orderProfit: string,
  mode: AllocationMode = "PERSON",
): AllocationValidation {
  const items: AllocationItem[] = [];
  let rateTotal = 0;
  let amountTotal = 0;

  if (mode === "ACTION") {
    const order: AllocationType[] = ["BUY", "SELL", "OPERATION", "COMPANY"];
    // 一个动作可以有多行（多人协作均分），按 allocation_type 分组校验。
    const groups = new Map<AllocationType, AllocationFormRow[]>();
    for (const row of rows) {
      const kind = (row.allocation_type ?? "") as AllocationType;
      if (!order.includes(kind)) {
        return { ok: false, error: "按操作分配只允许买号、售出、运营、公司四项" };
      }
      groups.set(kind, [...(groups.get(kind) ?? []), row]);
    }
    for (const requiredKind of ["BUY", "SELL"] as const) {
      if (!(groups.get(requiredKind)?.length)) {
        return { ok: false, error: "按操作分配必须包含买号和售出" };
      }
    }

    type Expanded = { kind: AllocationType; employee?: number | "COMPANY"; role?: string; rate: number; amount: number; hasRate: boolean; hasAmount: boolean };
    const expanded: Expanded[] = [];
    for (const kind of order) {
      const group = groups.get(kind) ?? [];
      if (!group.length) continue;
      const totalRow = group.find((row) => (row.share_mode ?? "PER_PERSON") === "TOTAL");
      if (totalRow) {
        const rateText = String(totalRow.allocation_rate ?? "").trim();
        const amountText = String(totalRow.allocation_amount ?? "").trim();
        const selectedMembers = employeeIds(totalRow.employee);
        const members = Array.isArray(totalRow.employee) || group.length === 1
          ? selectedMembers
          : group.flatMap((row) => employeeIds(row.employee));
        const optional = kind === "OPERATION" || kind === "COMPANY";
        if (!members.length && rateText === "" && amountText === "") {
          continue;
        }
        if (!members.length && kind !== "COMPANY") {
          return { ok: false, error: `${ALLOCATION_TYPE_LABEL[kind]} 请选择分润人员` };
        }
        const expandedMembers: Array<number | "COMPANY"> = kind === "COMPANY" ? ["COMPANY"] : members;
        const people = expandedMembers.length || 1;
        const rate = rateText === "" ? 0 : Number(rateText);
        const amount = amountText === "" ? 0 : Number(amountText);
        const hasRate = rateText !== "" && Number.isFinite(rate);
        const hasAmount = amountText !== "" && Number.isFinite(amount);
        if (!hasRate && !hasAmount) {
          if (optional) continue;
          return { ok: false, error: `${ALLOCATION_TYPE_LABEL[kind]} 请填写比例或金额` };
        }
        if (hasRate && rate < 0) {
          return { ok: false, error: `${ALLOCATION_TYPE_LABEL[kind]} 比例不能为负数` };
        }
        const rates = hasRate ? splitEven(rate, people) : [];
        const amounts = hasAmount ? splitEven(amount, people) : [];
        expandedMembers.forEach((member, index) => {
          expanded.push({
            kind,
            employee: member,
            role: totalRow.role || ALLOCATION_TYPE_ROLE[kind],
            rate: rates[index] ?? 0,
            amount: amounts[index] ?? 0,
            hasRate,
            hasAmount,
          });
        });
        continue;
      }
      for (const row of group) {
        const rateText = String(row.allocation_rate ?? "").trim();
        const amountText = String(row.allocation_amount ?? "").trim();
        const rate = Number(rateText);
        const amount = Number(amountText);
        const hasRate = rateText !== "" && Number.isFinite(rate);
        const hasAmount = amountText !== "" && Number.isFinite(amount);
        if (!hasRate && !hasAmount) {
          if ((kind === "OPERATION" || kind === "COMPANY") && !employeeIds(row.employee).length) continue;
          return { ok: false, error: `${ALLOCATION_TYPE_LABEL[kind]} 请填写比例或金额` };
        }
        if (hasRate && rate < 0) {
          return { ok: false, error: `${ALLOCATION_TYPE_LABEL[kind]} 比例不能为负数` };
        }
        expanded.push({
          kind,
          employee: row.employee === "COMPANY" ? "COMPANY" : employeeIds(row.employee)[0],
          role: row.role || ALLOCATION_TYPE_ROLE[kind],
          rate: hasRate ? rate : 0,
          amount: hasAmount ? amount : 0,
          hasRate,
          hasAmount,
        });
      }
    }

    // 一行可以同时填比例和金额（提交时按全局口径只取一个），
    // 但不能「有的行只填比例、有的行只填金额」——那样合计口径自相矛盾。
    const onlyRate = expanded.some((row) => row.hasRate && !row.hasAmount);
    const onlyAmount = expanded.some((row) => row.hasAmount && !row.hasRate);
    if (onlyRate && onlyAmount) {
      return { ok: false, error: "同一单的四项要么都按比例、要么都按金额，不能混填" };
    }
    const rateTotal = expanded.reduce((sum, row) => sum + row.rate, 0);
    const amountTotal = expanded.reduce((sum, row) => sum + row.amount, 0);
    const useRate = Math.abs(rateTotal - 100) <= 0.001 || amountTotal === 0;
    if (useRate) {
      if (Math.abs(rateTotal - 100) > 0.001) {
        return { ok: false, error: `四项比例合计必须为 100%，当前 ${Number(rateTotal.toFixed(2))}%` };
      }
    } else {
      const profit = Number(orderProfit);
      if (profit > 0 && amountTotal < 0) return { ok: false, error: "该单为盈利单，分润金额不能为负数" };
      if (profit < 0 && amountTotal > 0) return { ok: false, error: "该单为亏损单，分润金额必须填负数（亏损分担额）" };
      if (profit === 0) return { ok: false, error: "该单利润为 0，按金额分润只能填 0，请改用比例" };
      if (Math.abs(amountTotal) > Math.abs(profit)) {
        return { ok: false, error: `分润金额合计不能超过订单总利润 ${money(orderProfit)}` };
      }
    }
    const items: AllocationItem[] = expanded.map((row) => ({
      user_id: row.kind === "COMPANY" || row.employee == null || row.employee === "COMPANY" ? null : Number(row.employee),
      role: row.role || ALLOCATION_TYPE_ROLE[row.kind],
      allocation_type: row.kind,
      allocation_rate: useRate ? String(row.rate) : "0",
      allocation_amount: useRate ? "0" : String(row.amount),
    }));
    return { ok: true, items };
  }

  for (const row of rows) {
    const rate = String(row.allocation_rate ?? "").trim();
    const amount = String(row.allocation_amount ?? "").trim();
    const hasRate = Number(rate) > 0;
    // 亏损单的金额是负数（-300 = 分担 300 亏损），故不能用 `> 0` 判定「填了金额」。
    const hasAmount = amount !== "" && Number(amount) !== 0;
    if (!hasRate && !hasAmount) return { ok: false, error: "每行至少填比例或金额之一" };
    if (hasRate && hasAmount && Number.isFinite(Number(rate)) && Number.isFinite(Number(amount)) && Number(orderProfit) !== 0) {
      const expectedAmount = Number(orderProfit) * Number(rate) / 100;
      if (Math.abs(expectedAmount - Number(amount)) > 0.01) return { ok: false, error: "比例和金额换算不一致" };
    }
    if (hasRate) rateTotal += Number(rate);
    if (hasAmount) amountTotal += Number(amount);
    items.push({
      user_id: row.employee === "COMPANY" || Array.isArray(row.employee) ? null : Number(row.employee),
      role: row.role || "OWNER",
      allocation_rate: "0",
      allocation_amount: "0",
    });
  }
  const useRate = Math.abs(rateTotal - 100) <= 0.001 || amountTotal === 0;
  if (useRate && amountTotal === 0 && Math.abs(rateTotal - 100) > 0.001) {
    return { ok: false, error: "按比例分润时合计必须为 100%（也可改用金额）" };
  }
  if (!useRate && amountTotal !== 0) {
    const profit = Number(orderProfit);
    if (profit > 0 && amountTotal < 0) return { ok: false, error: "该单为盈利单，分润金额不能为负数" };
    if (profit < 0 && amountTotal > 0) return { ok: false, error: "该单为亏损单，分润金额必须填负数（亏损分担额）" };
    if (profit === 0) return { ok: false, error: "该单利润为 0，按金额分润只能填 0，请改用比例" };
    // 亏损单按绝对值比较：profit=-1000 时下限即 -1000（不得超额分担亏损）。
    if (Math.abs(amountTotal) > Math.abs(profit)) {
      return { ok: false, error: `分润金额合计不能超过订单总利润 ${money(orderProfit)}` };
    }
  }
  items.forEach((item, index) => {
    const row = rows[index];
    item.allocation_rate = useRate ? String(row.allocation_rate ?? "0") : "0";
    item.allocation_amount = useRate ? "0" : String(row.allocation_amount ?? "0");
  });
  return { ok: true, items };
}

export type CancelFormScope = "ORDERCANC" | "INVREFUND";

/** 从后端下发的可冲销动作里挑一条：显式选择优先，否则取第一条（reversibleEvents 已按新→旧排）。
 *  offsetEventId 来自表单，可能是 undefined / 字符串，统一 Number() 后比较，与旧内联逻辑一致。 */
export function pickCancelableEvent<T extends { event: { id: number }; remaining: string }>(
  reversible: T[],
  offsetEventId: unknown,
): T | undefined {
  return reversible.find((item) => item.event.id === Number(offsetEventId)) ?? reversible[0];
}

/**
 * 冲销/退款金额的确定与校验（原本内联在 submitCancelTransaction 里，无任何测试可触达）。
 * 规则：留空或不填 → 全额（取剩余可冲金额）；必须是正数；不得超过剩余可冲金额（1e-9 容差）。
 * 余额唯一来源是后端的 `event.cancellable_amount`，前端不重算。
 */
export function resolveCancelAmount(params: {
  scope: CancelFormScope;
  values: { amount?: string; cancel_amount?: string; refund_amount?: string };
  remaining: string;
}): { ok: true; amount: string } | { ok: false; error: string } {
  const { scope, values, remaining } = params;
  const raw = scope === "INVREFUND"
    ? (values.refund_amount ?? values.amount)
    : (values.cancel_amount ?? values.amount);
  const amount = (raw ?? "").trim() || remaining;
  if (Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    return { ok: false, error: "请输入有效的冲销金额" };
  }
  if (Number(amount) > Number(remaining) + 1e-9) {
    return { ok: false, error: `冲销金额不能超过该动作剩余可冲金额 ¥${remaining}` };
  }
  return { ok: true, amount };
}

/**
 * 订单编辑 PATCH 入参组装（原本内联在 submitEditOrder 里）。
 * 规则由后端契约决定，抽出来才可免挂载覆盖：
 *  1. 成交日期始终回写：后端按天数差平移本单事件/资金流水日期并重取规则快照；
 *  2. 快照密码被后端隐去（无 order.create 权限）→ 完全不带 account_snapshot，
 *     避免把隐藏密码覆盖成空；
 *  3. 快照是整体替换：表单里没有的控件（钱包实名 / 营地账号）沿用原快照值，
 *     否则编辑一次订单就把钱包实名抹掉。
 *  #15 需求2：账号快照一律可编辑（含已有登记事件的订单），不再因 hasPosted 而跳过回写。
 */
export function buildOrderPatchPayload(params: {
  values: Record<string, unknown>;
  snapshot: Order["account_snapshot"];
}): OrderPatchPayload {
  const { values, snapshot } = params;
  const payload: OrderPatchPayload = {};
  // 成交日期始终回写；账号快照在可见密码（具备 order.create 权限）时一律回写。
  payload.trade_date = values.trade_date as string;
  const note = (values.note as string | undefined)?.trim();
  payload.note = note ? note : null;
  payload.form_extra = (values.form_extra as Record<string, unknown> | undefined) ?? undefined;
  if (snapshot && snapshot.game_password) {
    payload.account_snapshot = {
      game_account: (values.snap_game_account as string) ?? snapshot.game_account,
      game_type: (values.snap_game_type as string) || null,
      game_password: (values.snap_game_password as string) || null,
      channel_region: (values.snap_channel_region as string) || null,
      bound_phone: (values.snap_bound_phone as string) || null,
      wallet_realname: (values.snap_wallet_realname as string) || snapshot.wallet_realname || null,
      camp_account: (values.snap_camp_account as string) || snapshot.camp_account || null,
      platform: (values.snap_platform as string) || null,
      purchase_price: (values.snap_purchase_price as string) || null,
      note: (values.snap_note as string) || null,
    };
  }
  return payload;
}

/**
 * 资金收支（REFUND）事件入参组装。两条规则此前只能靠挂载页面才能碰到：
 *  - 发生日期留空 → 取当天（后端不接受空日期）；
 *  - 资金账户「显式选择优先」：未选时保持 undefined，让后端按订单类型默认路由，
 *    不要擅自填 0 或空串（会被当成某个池的 id）。
 */
export function buildRefundEventPayload(params: {
  values: {
    amount: string;
    occurred_on?: Dayjs | null;
    pool_id?: number | string;
    reason?: string;
    operator_user_ids?: number[];
    form_extra?: Record<string, unknown>;
  };
  fallbackDate: string;
}): {
  event_type: "REFUND";
  amount: string;
  occurred_on: string;
  pool_id?: number;
  reason?: string;
  operator_user_ids?: number[];
  form_extra?: Record<string, unknown>;
} {
  const { values, fallbackDate } = params;
  return {
    event_type: "REFUND",
    amount: values.amount,
    occurred_on: values.occurred_on?.format("YYYY-MM-DD") ?? fallbackDate,
    pool_id: values.pool_id === undefined || values.pool_id === null || values.pool_id === ""
      ? undefined
      : Number(values.pool_id),
    reason: values.reason,
    operator_user_ids: values.operator_user_ids,
    form_extra: values.form_extra,
  };
}

export function formatOrderAmount(order: Order): string {
  if (order.installment_principal) {
    return `¥${order.installment_paid ?? "0.00"}/${order.installment_principal} · ${order.installment_periods ?? 0}期`;
  }
  return order.event_total ? `¥${money(order.event_total)}` : "-";
}

export function orderSearchText(order: Order): string {
  return [
    order.order_no,
    order.account_game_type,
    order.account_game_account,
    order.account_channel_region,
    order.party_name,
    order.party_source,
    order.note,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function orderMatchesBusinessMode(order: Order, mode: BusinessModeFilterKey): boolean {
  return mode === "all" || order.business_mode === mode || order.account_business_mode === mode;
}

export function filterBusinessOrders(
  orders: Order[],
  type: BusinessFilterKey,
  mode: BusinessModeFilterKey,
  keyword: string,
  gameType: string,
  inventoryStatus: string,
): Order[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  return orders.filter((order) => (
    (type === "all" || order.order_type === type)
    && orderMatchesBusinessMode(order, mode)
    && (gameType === "all" || order.account_game_type === gameType)
    && (inventoryStatus === "all" || order.account_status === inventoryStatus)
    && (!normalizedKeyword || orderSearchText(order).includes(normalizedKeyword))
  ));
}

export function countBusinessOrders(orders: Order[], type: BusinessFilterKey, mode: BusinessModeFilterKey): number {
  return orders.filter((order) => (
    (type === "all" || order.order_type === type)
    && orderMatchesBusinessMode(order, mode)
  )).length;
}

export const SCHEDULE_STATUS_LABEL: Record<string, string> = {
  PENDING: "待收",
  PARTIAL: "部分收取",
  PAID: "已付清",
  OVERDUE: "逾期",
  WAIVED: "已减免",
};

export const EVENT_PORTION_LABEL: Record<string, string> = { PRINCIPAL: "本金", PROFIT: "利润", GROSS: "总额" };
export const DELIVERY_MODE_LABEL: Record<string, string> = { PLATFORM_OPERATOR: "平台/本方操作换绑", CUSTOMER_SELF: "客户自行换绑" };
export const REFUND_RESPONSIBILITY_LABEL: Record<string, string> = { COMPANY: "公司", CUSTOMER: "客户", CONSIGNOR: "寄售方", PLATFORM: "平台", OTHER: "其他" };
