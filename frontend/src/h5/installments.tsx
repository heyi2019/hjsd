/** H5（≤640px）分期合约卡片列表。桌面由 useCompactLayout 控制不挂载，故不影响桌面表格与单测。 */
import { Space } from "antd";
import type { Installment, InstallmentDisposition, Order } from "../shared/api/catalog";
import { INSTALLMENT_STATUS_LABEL, installmentDisplayStatus } from "../shared/lib/format";
import { orderTypeLabel, BUSINESS_MODE_LABEL, ORDER_TYPE_LABEL } from "../shared/lib/labels";
import { configurableLabel } from "../shared/lib/optionSets";
import { orderMobileFields } from "../shared/lib/listColumns";
import { MoneyText, PermissionButton, StatusTag } from "../shared/ui";
import type { Permission } from "../shared/state/session";

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
  fieldOrder,
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
  fieldOrder?: string[];
}) {
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
              {orderMobileFields([
                { key: "order", label: "订单", value: order?.order_no ?? row.order_id },
                { key: "business", label: "业务", value: order ? BUSINESS_MODE_LABEL[order.account_business_mode ?? ""] || "-" : "-" },
                { key: "order_type", label: "类型", value: order ? orderTypeLabel(order.order_type, { ...ORDER_TYPE_LABEL }) : "-" },
                { key: "product", label: "产品", value: order ? [order.account_game_type, order.account_game_account].filter(Boolean).join(" / ") || "-" : "-" },
                { key: "party", label: "对方", value: order?.party_name || "-" },
                { key: "receivable", label: "总应收", value: <MoneyText value={row.total_receivable} /> },
                { key: "service_fee", label: "服务费", value: <MoneyText value={row.service_fee ?? "0"} /> },
                { key: "per_period_service_fee", label: "每期服务费", value: <MoneyText value={row.per_period_service_fee ?? "0"} /> },
                { key: "paid_amount", label: "已收", value: <MoneyText value={row.paid_amount} /> },
                { key: "bad_debt", label: "坏账", value: <MoneyText value={row.bad_debt_amount ?? "0"} /> },
                { key: "remaining", label: "剩余", value: <MoneyText value={row.remaining_receivable} /> },
              ], fieldOrder).map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
            </dl>
            <Space size={2}>
              <PermissionButton
                permission="order.event.post"
                size="small"
                disabled={["SETTLED", "DELIVERED", "CLOSED", "CANCELLED"].includes(row.status)}
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
                disabled={!(["PENDING", "ACTIVE", "OVERDUE"].includes(row.status))}
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
