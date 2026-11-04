import { useEffect, useState } from "react";
import { fetchCustomerDetail, type CustomerDetail } from "../../api";
import { customerStatusLabel, money, orderTypeGlyph, orderTypeLabel, orderTypeTone, statusLabel, statusTone } from "../../labels";
import { DetailHead, DetailNav, KeyValue } from "../../components/Detail";
import { navigate } from "../../router";

const ROLE_LABEL: Record<string, string> = {
  SELLER: "卖方",
  BUYER: "买方",
  CONSIGNOR: "寄售方",
  INSTALLMENT_CUSTOMER: "分期客户",
};

export function CustomerDetailPage({ customerId }: { customerId: number }) {
  const [data, setData] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    void fetchCustomerDetail(customerId)
      .then((detail) => {
        if (alive) setData(detail);
      })
      .catch((issue: Error) => {
        if (alive) setError(issue.message);
      });
    return () => {
      alive = false;
    };
  }, [customerId]);

  const customer = data?.customer;
  const overview = data?.overview;

  return (
    <div className="h5-page">
      <DetailNav title="客户详情" />

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}
      {!data && !error ? <p className="h5-empty">加载中…</p> : null}

      {customer ? (
        <>
          <DetailHead
            glyph={customer.display_name.slice(0, 1)}
            tone="blue"
            title={customer.display_name}
            subtitle={`${customer.customer_no}${customer.phone ? ` · ${customer.phone}` : ""}`}
            right={<span className="h5-pill h5-pill--gray">{customerStatusLabel(customer.status)}</span>}
          />

          {overview ? (
            <div className="h5-stats">
              <div className="h5-stat">
                <strong>{overview.order_count}</strong>
                <span>累计订单</span>
              </div>
              <div className="h5-stat">
                <strong>{overview.active_order_count}</strong>
                <span>进行中</span>
              </div>
              <div className="h5-stat">
                <strong>{overview.overdue_period_count}</strong>
                <span>逾期期数</span>
              </div>
            </div>
          ) : null}

          <section className="h5-section">
            <div className="h5-section__head"><h2>档案</h2></div>
            <KeyValue
              rows={[
                { label: "联系人", value: customer.contact_name },
                { label: "手机号", value: customer.phone },
                { label: "微信", value: customer.wechat },
                { label: "来源", value: customer.source },
                { label: "最近交易日", value: overview?.last_trade_date },
                { label: "分期待收", value: overview ? `¥${money(overview.installment_remaining_total)}` : null },
                { label: "备注", value: customer.note },
              ]}
            />
          </section>

          {data?.business && data.business.length > 0 ? (
            <section className="h5-section">
              <div className="h5-section__head"><h2>交易记录</h2></div>
              <ul className="h5-list">
                {data.business.map((row) => (
                  <li key={row.order_id}>
                    <button
                      type="button"
                      className="h5-row h5-row--link"
                      onClick={() => navigate(`/orders/${row.order_id}`)}
                    >
                      <span className={`h5-row__icon h5-row__icon--${orderTypeTone(row.order_type)}`}>
                        {orderTypeGlyph(row.order_type)}
                      </span>
                      <div className="h5-row__main">
                        <div className="h5-row__title">
                          <strong>{row.order_no}</strong>
                          <span className={`h5-pill h5-pill--${statusTone(row.status)}`}>
                            {statusLabel(row.status)}
                          </span>
                        </div>
                        <p className="h5-row__meta">
                          {orderTypeLabel(row.order_type)} · {row.trade_date}
                          {row.roles.length > 0
                            ? ` · ${row.roles.map((role) => ROLE_LABEL[role] ?? role).join("/")}`
                            : ""}
                        </p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
