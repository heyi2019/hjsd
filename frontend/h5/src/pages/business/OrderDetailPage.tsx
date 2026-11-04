/**
 * 订单详情：金额、档案、客户/合作方、事件时间线、资金流水，以及写操作入口。
 *
 * 数据来源有两层（这是最容易搞错的地方）：
 *  - `GET /orders/{id}` 只有单据字段，**不含事件**；
 *  - 事件、流水、客户/合作方在账号维度的 `GET /stocks/{account_id}/execution-detail`。
 *    一张账号可能挂着入库单与售出单两张单，所以要按 order_id 挑出当前这张。
 *  - 账号为空（纯快照单、历史数据）时降级为只展示单据信息，事件区显示为空。
 *
 * 三个操作的口径互不相同，按钮文案必须让用户分得清：
 *  - 编辑：改交易日期/备注/交付字段（PATCH），不改金额；
 *  - 取消订单：整单作废（POST /orders/{id}/cancel，需原因）；
 *  - 退款：已交付后按金额退（REFUND），需原因 + 责任方，且不能超过已收金额。
 *  - 冲销某一条事件（CANCEL）走「更多 → 冲销」以外的地方，本页不提供：
 *    它必须指定 offset_event_id，属于桌面端的精细操作。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cancelOrder,
  fetchExecutionDetail,
  fetchOrder,
  type AccountExecutionDetail,
  type ExecutionOrder,
  type OrderDetail,
} from "../../api";
import { ActionSheet, ConfirmSheet } from "../../components/Sheet";
import { DetailHead, KeyValue } from "../../components/Detail";
import { TextArea } from "../../forms/controls";
import {
  directionLabel,
  eventLabel,
  eventTone,
  money,
  orderTypeGlyph,
  orderTypeLabel,
  orderTypeTone,
  profitClass,
  statusLabel,
  statusTone,
} from "../../labels";
import { goBack, navigate } from "../../router";

const CUSTOMER_ROLE_LABEL: Record<string, string> = {
  SELLER: "卖方",
  BUYER: "买方",
  CONSIGNOR: "寄售方",
  INSTALLMENT_CUSTOMER: "分期客户",
};

const PARTY_ROLE_LABEL: Record<string, string> = {
  PEER: "同行",
  SUPPLIER: "供货方",
  PLATFORM: "平台",
  INTERMEDIARY: "中介",
};

/** form_extra 里可能嵌对象/数组，详情页只展示标量，避免把 JSON 糊到屏幕上。 */
function scalarEntries(extra: Record<string, unknown> | null | undefined) {
  if (!extra) return [];
  return Object.entries(extra).filter(
    ([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean",
  );
}

export function OrderDetailPage({ orderId }: { orderId: number }) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [execution, setExecution] = useState<ExecutionOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setOrder(null);
    setExecution(null);
    setError(null);
    void (async () => {
      try {
        const detail = await fetchOrder(orderId);
        if (!alive) return;
        setOrder(detail);
        if (detail.account_id) {
          const accountDetail: AccountExecutionDetail = await fetchExecutionDetail(detail.account_id);
          if (!alive) return;
          setExecution(accountDetail.orders.find((item) => item.order_id === detail.id) ?? null);
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : "加载订单失败");
      }
    })();
    return () => {
      alive = false;
    };
  }, [orderId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const doCancel = useCallback(async () => {
    if (!cancelReason.trim()) return;
    setBusy(true);
    try {
      await cancelOrder(orderId, { reason: cancelReason.trim() });
      setCancelOpen(false);
      setCancelReason("");
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取消失败");
    } finally {
      setBusy(false);
    }
  }, [cancelReason, orderId, reload]);

  const extra = scalarEntries(order?.form_extra);
  const events = execution?.events ?? [];
  const cashflows = execution?.cashflows ?? [];

  /** 已收金额与可退上限：只做展示提示，真正的校验在后端。 */
  const refundable = useMemo(() => {
    const received = events
      .filter((event) => event.is_posted && (event.event_type === "SELL" || event.event_type === "PAYMENT"))
      .reduce((sum, event) => sum + Number(event.amount || 0), 0);
    const refunded = events
      .filter((event) => event.is_posted && event.event_type === "REFUND")
      .reduce((sum, event) => sum + Number(event.amount || 0), 0);
    return Math.max(received - refunded, 0);
  }, [events]);

  const canRefund = refundable > 0 && order?.status !== "CANCELLED" && order?.status !== "VOID";

  return (
    <div className="h5-page h5-page--withdock">
      <header className="h5-navbar">
        <button type="button" className="h5-navbar__back" onClick={() => goBack("/business/ledger")}>
          返回
        </button>
        <div className="h5-navbar__title">订单详情</div>
        <div className="h5-navbar__spacer">
          {order ? (
            <button type="button" className="h5-navbar__action" onClick={() => setMoreOpen(true)}>
              更多
            </button>
          ) : null}
        </div>
      </header>

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
                {
                  label: "资本类型",
                  value:
                    order.capital_type === "ZERO"
                      ? "零成本"
                      : order.capital_type === "STOCK"
                        ? "库存"
                        : order.capital_type,
                },
                { label: "经办人", value: order.owner_name },
                {
                  label: "创建时间",
                  value: order.created_at ? order.created_at.slice(0, 16).replace("T", " ") : null,
                },
                { label: "备注", value: order.note },
              ]}
            />
          </section>

          {execution?.customers?.length || execution?.counterparties?.length ? (
            <section className="h5-section">
              <div className="h5-section__head"><h2>参与方</h2></div>
              <KeyValue
                rows={[
                  ...(execution?.customers ?? []).map((item) => ({
                    label: CUSTOMER_ROLE_LABEL[item.role] ?? item.role,
                    value: item.display_name,
                  })),
                  ...(execution?.counterparties ?? []).map((item) => ({
                    label: PARTY_ROLE_LABEL[item.role] ?? item.role,
                    value: item.display_name,
                  })),
                ]}
              />
            </section>
          ) : order.customer_roles?.length ? (
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

          <section className="h5-section">
            <div className="h5-section__head">
              <h2>事件</h2>
              <span className="h5-section__count">{events.length} 条</span>
            </div>
            {events.length === 0 ? (
              <p className="h5-empty">暂无事件记录</p>
            ) : (
              <ul className="h5-timeline">
                {events.map((event) => (
                  <li key={event.id} className="h5-timeline__item">
                    <span className={`h5-timeline__dot h5-timeline__dot--${eventTone(event.event_type)}`} />
                    <div className="h5-timeline__main">
                      <div className="h5-timeline__head">
                        <strong>{eventLabel(event.event_type)}</strong>
                        <span className="h5-timeline__amount">
                          ¥{money(event.amount)}
                        </span>
                      </div>
                      <p className="h5-timeline__meta">
                        {event.occurred_on} · {event.event_no}
                        {event.is_posted ? "" : " · 未过账"}
                      </p>
                      {event.note ? <p className="h5-timeline__note">{event.note}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {cashflows.length > 0 ? (
            <section className="h5-section">
              <div className="h5-section__head"><h2>资金流水</h2></div>
              <ul className="h5-list">
                {cashflows.map((flow) => (
                  <li key={flow.flow_no} className="h5-row">
                    <div className="h5-row__main">
                      <div className="h5-row__title">
                        <strong>{flow.category}</strong>
                      </div>
                      <p className="h5-row__meta">
                        {flow.occurred_on} · {flow.pool_name ?? "—"} · {directionLabel(flow.direction)}
                      </p>
                      {flow.note ? <p className="h5-row__meta">{flow.note}</p> : null}
                    </div>
                    <div className="h5-row__side">
                      <strong>
                        {flow.direction === "IN" ? "+" : "−"}
                        {money(flow.amount)}
                      </strong>
                    </div>
                  </li>
                ))}
              </ul>
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

          <section className="h5-section">
            <div className="h5-section__head"><h2>关联</h2></div>
            <div className="h5-linklist">
              {order.account_id ? (
                <button type="button" className="h5-linkrow" onClick={() => navigate(`/stocks/${order.account_id}`)}>
                  <span>库存账号</span>
                  <em>{order.account_game_account ?? "查看"} ›</em>
                </button>
              ) : null}
              <button type="button" className="h5-linkrow" onClick={() => navigate("/business/collections")}>
                <span>分期合约</span>
                <em>分期回款 ›</em>
              </button>
            </div>
          </section>
        </>
      ) : null}

      {order ? (
        <div className="h5-dock">
          <button type="button" className="h5-ghost" onClick={() => navigate(`/orders/${order.id}/edit`)}>
            编辑
          </button>
          <button type="button" className="h5-primary h5-primary--grow" onClick={() => setMoreOpen(true)}>
            更多操作
          </button>
        </div>
      ) : null}

      <ActionSheet
        open={moreOpen}
        title="订单操作"
        onClose={() => setMoreOpen(false)}
        actions={[
          {
            key: "refund",
            label: "登记退款",
            hint: canRefund ? `当前可退 ¥${money(refundable)}` : "已交付后才有可退余额",
            disabled: !canRefund,
            onSelect: () => navigate(`/orders/${orderId}/refund`),
          },
          {
            key: "edit",
            label: "编辑订单",
            hint: "交易日期、备注与交付信息",
            onSelect: () => navigate(`/orders/${orderId}/edit`),
          },
          {
            key: "cancel",
            label: "取消订单",
            hint: "整单作废，需填写原因",
            danger: true,
            disabled: order?.status === "CANCELLED" || order?.status === "VOID",
            onSelect: () => setCancelOpen(true),
          },
        ]}
      />

      <ConfirmSheet
        open={cancelOpen}
        title="取消这张订单？"
        description="作废后订单不再参与核算，来源库存账号会退回待售。此操作会写入审计。"
        okText="确认取消"
        cancelText="返回"
        danger
        busy={busy}
        onConfirm={() => void doCancel()}
        onCancel={() => setCancelOpen(false)}
      >
        <label className="h5-field">
          <div className="h5-field__label"><label>取消原因</label></div>
          <TextArea
            value={cancelReason}
            onChange={setCancelReason}
            rows={3}
            placeholder="请填写取消原因（必填）"
          />
        </label>
      </ConfirmSheet>
    </div>
  );
}
