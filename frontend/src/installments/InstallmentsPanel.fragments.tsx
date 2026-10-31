import { Space } from "antd";
import type { Installment, InstallmentDisposition, Order } from "../shared/api/catalog";
import { INSTALLMENT_STATUS_LABEL, installmentDisplayStatus } from "../shared/lib/format";
import { orderTypeLabel, BUSINESS_MODE_LABEL, ORDER_TYPE_LABEL } from "../shared/lib/labels";
import { configurableLabel } from "../shared/lib/optionSets";
import { MoneyText, PermissionButton, StatusTag } from "../shared/ui";
import type { Permission } from "../shared/state/session";

/** 合约类型页签与违约处置文案的回落值；词典加载后由选项词典接管（改造前即为这些文案）。 */
export const CONTRACT_TYPE_LABEL: Record<string, string> = {
  STOCK_SALE: "分期出售",
};
export const DISPOSITION_LABEL: Record<string, string> = {
  RECOVER: "回收",
  RESELL: "出售",
};

/** 期次状态与合约状态取值不同（PENDING/PARTIAL/PAID/OVERDUE/WAIVED），单独映射，避免复用合约标签出现裸英文。 */
export const SCHEDULE_STATUS_LABEL: Record<string, string> = {
  PENDING: "待收",
  PARTIAL: "部分收款",
  PAID: "已收",
  OVERDUE: "逾期",
  WAIVED: "已减免",
};

/** 移动端（≤640px）分期合约卡片列表。桌面由 useCompactLayout 控制不挂载，故不影响桌面表格与单测。 */
export function MobileInstallmentList({
  rows,
  orders,
  dispositions,
  settlePermission,
  onPay,
  onDeliver,
  onRecover,
  onRefund,
  onSettle,
  onDefault,
  onResale,
}: {
  rows: Installment[];
  orders: Order[];
  dispositions: Record<number, InstallmentDisposition[]>;
  settlePermission: Permission;
  onPay: (row: Installment) => void;
  onDeliver: (row: Installment) => void;
  onRecover: (row: Installment) => void;
  onRefund: (row: Installment) => void;
  onSettle: (row: Installment) => void;
  onDefault: (row: Installment) => void;
  onResale: (row: Installment) => void;
}) {
  const receivable = (row: Installment) => Number(row.total_receivable);

  if (rows.length === 0) return <div className="data-mobile-empty">暂无分期合约</div>;
  return (
    <div className="data-mobile-list">
      {[...rows].map((row) => {
        const order = orders.find((item) => item.id === row.order_id);
        const dispo = dispositions[row.id] ?? [];
        return (
          <article className="data-mobile-card" key={row.id}>
            <div className="data-mobile-card__topline">
              <span>{row.inst_no}</span>
              <StatusTag status={installmentDisplayStatus(row.status)} label={configurableLabel("INSTALLMENT_STATUS", installmentDisplayStatus(row.status), INSTALLMENT_STATUS_LABEL)} />
            </div>
            <dl className="data-mobile-card__meta">
              <div><dt>订单</dt><dd>{order?.order_no ?? row.order_id}</dd></div>
              <div><dt>业务</dt><dd>{order ? BUSINESS_MODE_LABEL[order.account_business_mode ?? ""] || "-" : "-"}</dd></div>
              <div><dt>类型</dt><dd>{order ? orderTypeLabel(order.order_type, { ...ORDER_TYPE_LABEL }) : "-"}</dd></div>
              <div><dt>产品</dt><dd>{order ? [order.account_game_type, order.account_game_account].filter(Boolean).join(" / ") || "-" : "-"}</dd></div>
              <div><dt>对方</dt><dd>{order?.party_name || "-"}</dd></div>
              <div><dt>总应收</dt><dd><MoneyText value={receivable(row).toFixed(2)} /></dd></div>
              <div><dt>已收</dt><dd><MoneyText value={row.paid_amount} /></dd></div>
              <div><dt>坏账</dt><dd><MoneyText value={row.bad_debt_amount ?? "0"} /></dd></div>
              <div>
                <dt>剩余</dt>
                <dd><MoneyText value={(receivable(row) - Number(row.paid_amount) - Number(row.bad_debt_amount ?? 0)).toFixed(2)} /></dd>
              </div>
            </dl>
            <Space size={2}>
              <PermissionButton
                permission="order.event.post"
                size="small"
                disabled={["DELIVERED", "CLOSED", "CANCELLED"].includes(row.status)}
                onClick={() => onPay(row)}
              >
                登记收款
              </PermissionButton>
              <PermissionButton
                permission="order.event.post"
                size="small"
                type="primary"
                disabled={row.status !== "SETTLED"}
                onClick={() => onDeliver(row)}
              >
                换绑交付
              </PermissionButton>
              <PermissionButton
                permission="order.update"
                size="small"
                disabled={!(["CLOSED", "OVERDUE", "DEFAULTED"].includes(row.status)) || dispo.some((item) => item.action === "RECOVER")}
                onClick={() => onRecover(row)}
              >
                登记回收
              </PermissionButton>
              <PermissionButton
                permission="order.event.post"
                size="small"
                danger
                disabled={!(["PENDING", "ACTIVE", "OVERDUE", "SETTLED"].includes(row.status))}
                onClick={() => onRefund(row)}
              >
                终止分期并退款
              </PermissionButton>
              <PermissionButton
                permission={settlePermission}
                size="small"
                disabled={!(["PENDING", "ACTIVE", "OVERDUE"].includes(row.status))}
                onClick={() => onSettle(row)}
              >
                提前结清
              </PermissionButton>
              <PermissionButton
                permission="order.update"
                size="small"
                danger
                disabled={!(["ACTIVE", "OVERDUE"].includes(row.status))}
                onClick={() => onDefault(row)}
              >
                登记违约
              </PermissionButton>
              {["CLOSED", "OVERDUE", "DEFAULTED"].includes(row.status) && dispo.some((item) => item.action === "RECOVER") && !dispo.some((item) => item.action === "RESELL") && (
                <PermissionButton permission="order.update" size="small" onClick={() => onResale(row)}>
                  登记出售
                </PermissionButton>
              )}
            </Space>
          </article>
        );
      })}
    </div>
  );
}
