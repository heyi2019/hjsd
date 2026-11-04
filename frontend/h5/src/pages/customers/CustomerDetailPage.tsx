/**
 * 客户详情：档案 + 交易记录 + 三个写操作（编辑 / 合并 / 停用）。
 *
 * 三个操作的风险等级不同，入口也必须不同：
 *  - 编辑：常态操作，直接放 dock 主按钮；
 *  - 停用：可逆（能再启用），但会让客户从下单选项里消失 → ActionSheet + 一句确认；
 *  - 合并：**不可逆**，源档案会被标记 MERGED 且订单/线索迁到目标档案，
 *    所以必须选目标客户 + 填原因，走独立 Sheet，不许一键执行。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchCustomerDetail,
  listCustomers,
  mergeCustomer,
  setCustomerStatus,
  type CustomerDetail,
  type CustomerRow,
  type SessionUser,
} from "../../api";
import { ActionSheet, ConfirmSheet, Sheet } from "../../components/Sheet";
import { DetailHead, KeyValue } from "../../components/Detail";
import { PickerField, TextArea } from "../../forms/controls";
import {
  customerStatusLabel,
  money,
  orderTypeGlyph,
  orderTypeLabel,
  orderTypeTone,
  statusLabel,
  statusTone,
} from "../../labels";
import { can } from "../../perm";
import { goBack, navigate } from "../../router";

const ROLE_LABEL: Record<string, string> = {
  SELLER: "卖方",
  BUYER: "买方",
  CONSIGNOR: "寄售方",
  INSTALLMENT_CUSTOMER: "分期客户",
};

export function CustomerDetailPage({ customerId, user }: { customerId: number; user: SessionUser | null }) {
  const [data, setData] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [moreOpen, setMoreOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [candidates, setCandidates] = useState<CustomerRow[]>([]);
  const [targetId, setTargetId] = useState("");
  const [mergeReason, setMergeReason] = useState("");
  const [busy, setBusy] = useState(false);

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
  }, [customerId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  // 合并候选：只在打开面板时拉，且排除自己与已合并的档案。
  useEffect(() => {
    if (!mergeOpen) return undefined;
    let alive = true;
    void listCustomers({ limit: 500, status: "ACTIVE" })
      .then((page) => {
        if (alive) setCandidates((page.items ?? []).filter((row) => row.id !== customerId));
      })
      .catch(() => {
        if (alive) setCandidates([]);
      });
    return () => {
      alive = false;
    };
  }, [customerId, mergeOpen]);

  const customer = data?.customer;
  const overview = data?.overview;
  const canUpdate = can(user, "customer.update");
  const canMerge = can(user, "customer.merge");
  const isActive = customer?.status === "ACTIVE";
  const isMerged = customer?.status === "MERGED";

  const targetOptions = useMemo(
    () =>
      candidates.map((row) => ({
        value: String(row.id),
        label: row.display_name,
        hint: row.phone ?? row.customer_no,
      })),
    [candidates],
  );

  const doMerge = useCallback(async () => {
    if (!targetId || !mergeReason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await mergeCustomer(customerId, Number(targetId), mergeReason.trim());
      setMergeOpen(false);
      setTargetId("");
      setMergeReason("");
      // 合并后源档案作废，停在原页只会看到一片空白，直接退回列表。
      navigate("/customers", true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "合并失败");
    } finally {
      setBusy(false);
    }
  }, [customerId, mergeReason, targetId]);

  const doToggleStatus = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await setCustomerStatus(customerId, isActive ? "DISABLED" : "ACTIVE");
      setDisableOpen(false);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }, [customerId, isActive, reload]);

  return (
    <div className={`h5-page${canUpdate && !isMerged ? " h5-page--withdock" : ""}`}>
      <header className="h5-navbar">
        <button type="button" className="h5-navbar__back" onClick={() => goBack("/customers")} aria-label="返回">
          返回
        </button>
        <span className="h5-navbar__title">客户详情</span>
        <span className="h5-navbar__spacer">
          {canUpdate && !isMerged ? (
            <button type="button" className="h5-navbar__action" onClick={() => setMoreOpen(true)}>
              更多
            </button>
          ) : null}
        </span>
      </header>

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

      {customer && canUpdate && !isMerged ? (
        <div className="h5-dock">
          <button type="button" className="h5-ghost" onClick={() => setMoreOpen(true)}>
            更多
          </button>
          <button
            type="button"
            className="h5-primary h5-primary--grow"
            onClick={() => navigate(`/customers/${customerId}/edit`)}
          >
            编辑档案
          </button>
        </div>
      ) : null}

      <ActionSheet
        open={moreOpen}
        title="客户操作"
        onClose={() => setMoreOpen(false)}
        actions={[
          {
            key: "edit",
            label: "编辑档案",
            hint: "名称、联系方式、来源与备注",
            disabled: !canUpdate,
            onSelect: () => navigate(`/customers/${customerId}/edit`),
          },
          {
            key: "merge",
            label: "合并到其他客户",
            hint: canMerge ? "订单与需求会迁到目标档案，不可撤销" : "需要合并权限",
            disabled: !canMerge,
            danger: true,
            onSelect: () => setMergeOpen(true),
          },
          {
            key: "status",
            label: isActive ? "停用客户" : "重新启用",
            hint: isActive ? "停用后不能再被新订单选用" : "启用后可继续下单",
            disabled: !canUpdate,
            danger: isActive,
            onSelect: () => setDisableOpen(true),
          },
        ]}
      />

      <Sheet
        open={mergeOpen}
        title="合并到哪个客户？"
        description="源档案会被标记为「已合并」，其订单、分期与需求全部迁到目标档案。此操作不可撤销。"
        onClose={() => setMergeOpen(false)}
      >
        <PickerField
          label="目标客户"
          required
          value={targetId}
          options={targetOptions}
          searchable
          onChange={setTargetId}
          placeholder="搜索并选择目标客户"
        />
        <label className="h5-field">
          <div className="h5-field__label"><label>合并原因</label></div>
          <TextArea
            value={mergeReason}
            onChange={setMergeReason}
            rows={3}
            placeholder="例如：同一人重复建档"
          />
        </label>
        <div className="h5-sheet__confirm">
          <button type="button" className="h5-ghost" onClick={() => setMergeOpen(false)} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="h5-primary h5-primary--danger"
            onClick={() => void doMerge()}
            disabled={!targetId || !mergeReason.trim() || busy}
          >
            {busy ? "处理中…" : "确认合并"}
          </button>
        </div>
      </Sheet>

      <ConfirmSheet
        open={disableOpen}
        title={isActive ? "停用这个客户？" : "重新启用这个客户？"}
        description={
          isActive
            ? "停用后该客户不再出现在下单/售出的客户选择里，历史订单不受影响。"
            : "启用后该客户重新可以被新订单选用。"
        }
        okText={isActive ? "确认停用" : "确认启用"}
        cancelText="返回"
        danger={isActive}
        busy={busy}
        onConfirm={() => void doToggleStatus()}
        onCancel={() => setDisableOpen(false)}
      />
    </div>
  );
}
