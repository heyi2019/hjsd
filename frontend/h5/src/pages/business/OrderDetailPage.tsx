import { useEffect, useState } from "react";
import { fetchOrder, type OrderDetail } from "../../api";
import {
  money,
  orderTypeGlyph,
  orderTypeLabel,
  orderTypeTone,
  profitClass,
  statusLabel,
  statusTone,
} from "../../labels";
import { DetailHead, DetailNav, KeyValue } from "../../components/Detail";

const CUSTOMER_ROLE_LABEL: Record<string, string> = {
  SELLER: "卖方",
  BUYER: "买方",
  CONSIGNOR: "寄售方",
  INSTALLMENT_CUSTOMER: "分期客户",
};

/** form_extra 里可能嵌对象/数组，详情页只展示标量，避免把 JSON 直接糊到屏幕上 */
function scalarEntries(extra: Record<string, unknown> | null | undefined) {
  if (!extra) return [];
  return Object.entries(extra).filter(
    ([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean",
  );
}

export function OrderDetailPage({ orderId }: { orderId: number }) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setOrder(null);
    setError(null);
    void fetchOrder(orderId)
      .then((data) => {
        if (alive) setOrder(data);
      })
      .catch((issue: Error) => {
        if (alive) setError(issue.message);
      });
    return () => {
      alive = false;
    };
  }, [orderId]);

  const extra = scalarEntries(order?.form_extra);

  return (
    <div className="h5-page">
      <DetailNav title="订单详情" />

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}
      {!order && !error ? <p className="h5-empty">加载中…</p> : null}

      {order ? (
        <>
          <DetailHead
            glyph={orderTypeGlyph(order.order_type)}
            tone={orderTypeTone(order.order_type)}
            title={order.order_no}
            subtitle={`${orderTypeLabel(order.order_type)} · ${order.trade_date}`}
            right={
              <span className={`h5-pill h5-pill--${statusTone(order.status)}`}>
                {statusLabel(order.status)}
              </span>
            }
          />

          <section className="h5-section">
            <div className="h5-section__head"><h2>金额</h2></div>
            <div className="h5-figures">
              <div>
                <span>成交总额</span>
                <strong>¥{money(order.event_total)}</strong>
              </div>
              <div>
                <span>利润</span>
                <strong className={profitClass(order.profit_base)}>¥{money(order.profit_base)}</strong>
              </div>
            </div>
          </section>

          <section className="h5-section">
            <div className="h5-section__head"><h2>基本信息</h2></div>
            <KeyValue
              rows={[
                { label: "业务类型", value: orderTypeLabel(order.order_type) },
                { label: "交易日期", value: order.trade_date },
                { label: "交易对方", value: order.party_name },
                { label: "游戏账号", value: order.account_game_account },
                { label: "资本类型", value: order.capital_type === "ZERO" ? "零成本" : order.capital_type === "STOCK" ? "库存" : order.capital_type },
                { label: "经办人", value: order.owner_name },
                { label: "创建时间", value: order.created_at ? order.created_at.slice(0, 16).replace("T", " ") : null },
                { label: "备注", value: order.note },
              ]}
            />
          </section>

          {order.customer_roles && order.customer_roles.length > 0 ? (
            <section className="h5-section">
              <div className="h5-section__head"><h2>客户角色</h2></div>
              <KeyValue
                rows={order.customer_roles.map((role) => ({
                  label: CUSTOMER_ROLE_LABEL[role.role] ?? role.role,
                  value: role.customer_name ?? `#${role.customer_id}`,
                }))}
              />
            </section>
          ) : null}

          {extra.length > 0 ? (
            <section className="h5-section">
              <div className="h5-section__head"><h2>扩展字段</h2></div>
              <KeyValue
                rows={extra.map(([key, value]) => ({
                  label: key,
                  value: typeof value === "boolean" ? (value ? "是" : "否") : String(value),
                }))}
              />
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
