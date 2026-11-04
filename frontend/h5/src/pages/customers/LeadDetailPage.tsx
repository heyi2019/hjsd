/**
 * 需求详情：意向登记 → 转单（关联实际订单）或关闭。
 *
 * 转单为什么必须挑订单：需求本身不产生单据，后端 `POST /leads/{id}/convert`
 * 要的是真实 `order_id`。所以这里做成「先搜订单号 → 选中 → 转单」，
 * 而不是让用户手填一个订单 ID —— 手填必然填错，错的是别人的单。
 *
 * 关闭是终态（OPEN → CLOSED），必须留原因；已转单/已关闭的需求不再提供写操作。
 */
import { useCallback, useEffect, useState } from "react";
import {
  closeLead,
  convertLead,
  fetchCustomerDetail,
  fetchLead,
  listOrders,
  type LeadRow,
  type OrderRow,
} from "../../api";
import { ConfirmSheet, Sheet } from "../../components/Sheet";
import { DetailHead, KeyValue } from "../../components/Detail";
import { TextArea, TextInput } from "../../forms/controls";
import { money, orderTypeLabel, statusLabel, statusTone } from "../../labels";
import { goBack, navigate } from "../../router";

const REQUEST_TYPE_LABEL: Record<string, string> = {
  FIND_ACCOUNT: "找号",
  SELL_ACCOUNT: "卖号",
  SPECIFIC_SEARCH: "指定找号",
};

const LEAD_STATUS_LABEL: Record<string, string> = {
  OPEN: "跟进中",
  CONVERTED: "已转单",
  CLOSED: "已关闭",
};

const LEAD_STATUS_TONE: Record<string, string> = {
  OPEN: "orange",
  CONVERTED: "green",
  CLOSED: "gray",
};

export function LeadDetailPage({ leadId }: { leadId: number }) {
  const [lead, setLead] = useState<LeadRow | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [convertOpen, setConvertOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<OrderRow | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLead(null);
    setError(null);
    void (async () => {
      try {
        const row = await fetchLead(leadId);
        if (!alive) return;
        setLead(row);
        // 客户名单独取：线索接口只回 customer_id，直接显示 #12 用户看不懂。
        try {
          const detail = await fetchCustomerDetail(row.customer_id);
          if (alive) setCustomerName(detail.customer.display_name);
        } catch {
          if (alive) setCustomerName(null);
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : "加载需求失败");
      }
    })();
    return () => {
      alive = false;
    };
  }, [leadId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  // 订单搜索：输入停下 300ms 再发，避免每敲一个字打一次后端。
  useEffect(() => {
    if (!convertOpen) return undefined;
    let alive = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void listOrders({ keyword: keyword.trim(), limit: 10 })
        .then((page) => {
          if (alive) setOrders(page.items ?? []);
        })
        .catch(() => {
          if (alive) setOrders([]);
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [convertOpen, keyword]);

  const doConvert = useCallback(async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await convertLead(leadId, picked.id);
      setConvertOpen(false);
      setPicked(null);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "转单失败");
    } finally {
      setBusy(false);
    }
  }, [leadId, picked, reload]);

  const doClose = useCallback(async () => {
    if (!closeReason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await closeLead(leadId, closeReason.trim());
      setCloseOpen(false);
      setCloseReason("");
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "关闭失败");
    } finally {
      setBusy(false);
    }
  }, [closeReason, leadId, reload]);

  const status = lead?.status ?? "";
  const isOpen = status === "OPEN";

  return (
    <div className={`h5-page${isOpen ? " h5-page--withdock" : ""}`}>
      <header className="h5-navbar">
        <button type="button" className="h5-navbar__back" onClick={() => goBack("/customers/leads")}>
          返回
        </button>
        <div className="h5-navbar__title">需求详情</div>
        <div className="h5-navbar__spacer" />
      </header>

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}
      {!lead && !error ? <p className="h5-empty">加载中…</p> : null}

      {lead ? (
        <>
          <DetailHead
            glyph={REQUEST_TYPE_LABEL[lead.request_type]?.slice(0, 1) ?? "需"}
            tone={isOpen ? "orange" : "gray"}
            title={customerName ?? `客户 #${lead.customer_id}`}
            subtitle={`${lead.lead_no} · ${REQUEST_TYPE_LABEL[lead.request_type] ?? lead.request_type}`}
            right={
              <span className={`h5-pill h5-pill--${LEAD_STATUS_TONE[status] ?? "gray"}`}>
                {LEAD_STATUS_LABEL[status] ?? status}
              </span>
            }
          />

          <section className="h5-section">
            <div className="h5-section__head"><h2>需求内容</h2></div>
            <KeyValue
              rows={[
                { label: "需求类型", value: REQUEST_TYPE_LABEL[lead.request_type] ?? lead.request_type },
                { label: "预算", value: lead.budget ? `¥${money(lead.budget)}` : "未填" },
                { label: "需求目标", value: lead.target },
                { label: "登记时间", value: lead.created_at ? lead.created_at.slice(0, 16).replace("T", " ") : null },
                { label: "备注", value: lead.note },
                ...(lead.closed_reason ? [{ label: "关闭原因", value: lead.closed_reason }] : []),
              ]}
            />
          </section>

          <section className="h5-section">
            <div className="h5-section__head"><h2>关联</h2></div>
            <div className="h5-linklist">
              <button
                type="button"
                className="h5-linkrow"
                onClick={() => navigate(`/customers/${lead.customer_id}`)}
              >
                <span>客户档案</span>
                <em>{customerName ?? "查看"} ›</em>
              </button>
              {lead.converted_order_id ? (
                <button
                  type="button"
                  className="h5-linkrow"
                  onClick={() => navigate(`/orders/${lead.converted_order_id}`)}
                >
                  <span>转单订单</span>
                  <em>#{lead.converted_order_id} ›</em>
                </button>
              ) : null}
            </div>
          </section>
        </>
      ) : null}

      {lead && isOpen ? (
        <div className="h5-dock">
          <button type="button" className="h5-ghost" onClick={() => setCloseOpen(true)}>
            关闭需求
          </button>
          <button type="button" className="h5-primary h5-primary--grow" onClick={() => setConvertOpen(true)}>
            转成订单
          </button>
        </div>
      ) : null}

      <Sheet
        open={convertOpen}
        title="关联到哪张订单？"
        description="选一张已存在的订单完成转单；需求本身不生成单据。"
        onClose={() => {
          setConvertOpen(false);
          setPicked(null);
        }}
      >
        <div className="h5-field">
          <div className="h5-field__label"><label htmlFor="lead-order-search">搜索订单号 / 客户</label></div>
          <TextInput
            id="lead-order-search"
            value={keyword}
            onChange={setKeyword}
            placeholder="输入订单号，如 HS0064"
          />
        </div>

        {searching ? <p className="h5-empty">搜索中…</p> : null}
        {!searching && orders.length === 0 ? <p className="h5-empty">没有匹配的订单</p> : null}

        <ul className="h5-list">
          {orders.map((order) => {
            const selected = picked?.id === order.id;
            return (
              <li key={order.id}>
                <button
                  type="button"
                  className={`h5-row h5-row--link${selected ? " is-selected" : ""}`}
                  onClick={() => setPicked(order)}
                >
                  <div className="h5-row__main">
                    <div className="h5-row__title">
                      <strong>{order.order_no}</strong>
                      <span className={`h5-pill h5-pill--${statusTone(order.status)}`}>
                        {statusLabel(order.status)}
                      </span>
                    </div>
                    <p className="h5-row__meta">
                      {orderTypeLabel(order.order_type)} · {order.trade_date}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="h5-sheet__confirm">
          <button
            type="button"
            className="h5-ghost"
            onClick={() => {
              setConvertOpen(false);
              setPicked(null);
            }}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="h5-primary"
            onClick={() => void doConvert()}
            disabled={!picked || busy}
          >
            {busy ? "处理中…" : picked ? `转单到 ${picked.order_no}` : "请先选择订单"}
          </button>
        </div>
      </Sheet>

      <ConfirmSheet
        open={closeOpen}
        title="关闭这条需求？"
        description="关闭后不能再转单，只能作为历史记录查看。"
        okText="确认关闭"
        cancelText="返回"
        danger
        busy={busy}
        onConfirm={() => void doClose()}
        onCancel={() => setCloseOpen(false)}
      >
        <label className="h5-field">
          <div className="h5-field__label"><label>关闭原因</label></div>
          <TextArea
            value={closeReason}
            onChange={setCloseReason}
            rows={3}
            placeholder="例如：客户已放弃 / 已在别处成交"
          />
        </label>
      </ConfirmSheet>
    </div>
  );
}
