/** 资金中心：移动端子组件 + 纯工具/常量（从 FundsPage.tsx 提取，降低主组件体积）。 */
import { Space } from "antd";
import { MoneyText, PermissionButton, StatusTag } from "../shared/ui";
import { configurableLabel } from "../shared/lib/optionSets";
import { formatDateTimeMinute } from "../shared/lib/format";
import { orderMobileFields } from "../shared/lib/listColumns";
import { ACCOUNTING_ATTRIBUTE_LABEL, FUND_NATURE_LABEL, POOL_OWNERSHIP_LABEL } from "../shared/lib/labels";
import type { Cashflow, Deposit, Pool, PoolBalance } from "../shared/api/catalog";

// 与 backend/app/finance/attributes.py 的 _ALLOWED_ATTRIBUTES_BY_FUND_NATURE 保持一致：
// 资金性质决定可用核算属性，非法组合后端直接 422，此处事前收窄避免误选。
export const ALLOWED_ATTRIBUTES_BY_FUND_NATURE: Record<string, string[]> = {
  BUSINESS: [
    "SELF_REVENUE",
    "SELF_DIRECT_COST",
    "TH_DIRECT_COST",
    "TH_REVENUE",
    "SERVICE_REVENUE",
    "REBATE_INCOME",
    "OPERATING_EXPENSE",
    "REVERSAL",
    "REFUND",
  ],
  EXTERNAL: ["DEPOSIT", "EXTERNAL_FUNDING", "REVERSAL"],
  INTERNAL: ["INTERNAL_TRANSFER"],
};

/** 新增流水的 nature 口径（纯函数，供单测矩阵直接覆盖）：
 *  外部/受托 → EXTERNAL_IN；内部调拨 → INTERNAL；本方经营按流向二分。 */
export const deriveCashflowNature = (fundNature: string, direction: string): string =>
  fundNature === "EXTERNAL" ? "EXTERNAL_IN" : fundNature === "INTERNAL" ? "INTERNAL" : direction === "IN" ? "BUSINESS_IN" : "BUSINESS_OUT";

/** 移动端（≤640px）资金池总览卡片列表。桌面由 useCompactLayout 控制不挂载，故不影响桌面表格与单测。 */
export function MobilePoolList({ rows, balances, fieldOrder }: { rows: Pool[]; balances: Record<number, PoolBalance>; fieldOrder?: string[] }) {
  if (rows.length === 0) return <div className="data-mobile-empty">尚未配置资金池</div>;
  return (
    <div className="data-mobile-list">
      {rows.map((row) => (
        <article className="data-mobile-card" key={row.id}>
          <div className="data-mobile-card__topline">
            <span>{`${row.name}（${row.code}）`}</span>
            <StatusTag status={row.status} optionSet="POOL_STATUS" />
          </div>
          <dl className="data-mobile-card__meta">
            {orderMobileFields([
              { key: "ownership", label: "归属", value: POOL_OWNERSHIP_LABEL[row.ownership] ?? row.ownership },
              { key: "income", label: "收入", value: <MoneyText value={balances[row.id]?.income} /> },
              { key: "expense", label: "支出", value: <MoneyText value={balances[row.id]?.expense} /> },
              { key: "deposit_held", label: "押金", value: <MoneyText value={balances[row.id]?.deposit_held} /> },
              { key: "available", label: "可用余额", value: <MoneyText value={balances[row.id]?.available} strong /> },
            ], fieldOrder).map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
          </dl>
        </article>
      ))}
    </div>
  );
}

/** 移动端（≤640px）资金流水卡片列表。 */
export function MobileCashflowList({
  rows,
  onReverse,
  fieldOrder,
}: {
  rows: Cashflow[];
  onReverse: (row: Cashflow) => void;
  fieldOrder?: string[];
}) {
  if (rows.length === 0) return <div className="data-mobile-empty">暂无资金流水</div>;
  return (
    <div className="data-mobile-list">
      {rows.map((row) => (
        <article className="data-mobile-card" key={row.id}>
          <div className="data-mobile-card__topline">
            <span>{row.flow_no}</span>
            <StatusTag
              status={row.status}
              label={configurableLabel("FUND_FLOW_STATUS", row.status, { APPROVED: "已入账" })}
            />
          </div>
          <dl className="data-mobile-card__meta">
            {orderMobileFields([
              { key: "order_no", label: "订单号", value: row.order_no || "—" },
              { key: "occurred_on", label: "日期", value: row.occurred_on },
              { key: "occurred_at", label: "建立时间", value: formatDateTimeMinute(row.occurred_at) },
              { key: "category", label: "类别", value: row.category },
              { key: "fund_nature", label: "资金性质", value: FUND_NATURE_LABEL[row.fund_nature ?? (row.nature?.startsWith("EXTERNAL") ? "EXTERNAL" : "BUSINESS")] ?? row.fund_nature ?? "—" },
              { key: "accounting_attribute", label: "核算属性", value: ACCOUNTING_ATTRIBUTE_LABEL[row.accounting_attribute ?? ""] ?? row.accounting_attribute ?? "—" },
              { key: "direction", label: "收支", value: row.direction === "IN" ? "收入" : "支出" },
              { key: "nature", label: "流向", value: row.nature || "—" },
              { key: "amount", label: "金额", value: <MoneyText value={row.amount} strong /> },
              { key: "source", label: "来源", value: row.source || "—" },
              { key: "note", label: "备注", value: row.note || "—" },
            ], fieldOrder).map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
          </dl>
          <Space size={2}>
            {row.status === "APPROVED" && !row.reversal_of_id && !rows.some((flow) => flow.reversal_of_id === row.id) && !row.order_id && !row.deposit_id && !row.transfer_id && !row.order_event_id && (
              <PermissionButton permission="deposit.post" size="small" onClick={() => onReverse(row)}>冲销</PermissionButton>
            )}
          </Space>
        </article>
      ))}
    </div>
  );
}

/** 移动端（≤640px）押金占用卡片列表。 */
export function MobileDepositList({
  rows,
  pools,
  onRelease,
  onLoss,
  onCancel,
  fieldOrder,
}: {
  rows: Deposit[];
  pools: Pool[];
  onRelease: (row: Deposit) => void;
  onLoss: (row: Deposit) => void;
  onCancel: (row: Deposit) => void;
  fieldOrder?: string[];
}) {
  if (rows.length === 0) return <div className="data-mobile-empty">暂无押金占用</div>;
  return (
    <div className="data-mobile-list">
      {rows.map((row) => (
        <article className="data-mobile-card" key={row.id}>
          <div className="data-mobile-card__topline">
            <span>{pools.find((pool) => pool.id === row.pool_id)?.name ?? row.pool_id}</span>
            <StatusTag status={row.status} optionSet="DEPOSIT_STATUS" />
          </div>
          <dl className="data-mobile-card__meta">
            {orderMobileFields([
              { key: "paid_amount", label: "占用金额", value: <MoneyText value={row.paid_amount} /> },
              { key: "counterparty", label: "对手方", value: row.counterparty_id == null ? "—" : `#${row.counterparty_id}` },
              { key: "source_order", label: "来源订单", value: row.source_order_id == null ? "—" : `#${row.source_order_id}` },
              { key: "expected_release_on", label: "预计释放", value: row.expected_release_on || "—" },
              { key: "returned_amount", label: "已释放", value: <MoneyText value={row.returned_amount} /> },
              { key: "lost_amount", label: "已损失", value: <MoneyText value={row.lost_amount ?? "0.00"} /> },
              { key: "remaining", label: "剩余", value: <MoneyText value={(Number(row.paid_amount) - Number(row.returned_amount) - Number(row.lost_amount ?? 0)).toFixed(2)} /> },
            ], fieldOrder).map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
          </dl>
          <Space size={2}>
            <PermissionButton
              permission="deposit.post"
              size="small"
              disabled={row.status === "RETURNED" || row.status === "LOST" || row.status === "CANCELLED"}
              onClick={() => onRelease(row)}
            >
              释放
            </PermissionButton>
            <PermissionButton
              permission="deposit.post"
              size="small"
              disabled={row.status === "RETURNED" || row.status === "LOST" || row.status === "CANCELLED"}
              onClick={() => onLoss(row)}
            >
              登记损失
            </PermissionButton>
            <PermissionButton
              permission="deposit.post"
              size="small"
              danger
              disabled={row.status !== "PAID"}
              onClick={() => onCancel(row)}
            >
              取消
            </PermissionButton>
          </Space>
        </article>
      ))}
    </div>
  );
}
