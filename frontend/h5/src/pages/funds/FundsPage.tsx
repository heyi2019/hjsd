/**
 * 资金中心外壳：总览卡 + 四个子页（流水 / 账户 / 对账 / 押金）。
 *
 * 为什么拆子页而不是全塞一屏：移动端一屏能承载的信息量有限，账户余额、流水、
 * 对账、押金四类数据的操作频率差别很大，混在一屏会让"记一笔"这类高频入口
 * 被挤到需要滑很久的位置。「我的」与「客户」同样采用这个结构。
 *
 * 口径提醒：手工登记的收支**提交即入账**（后端独立流水直接 APPROVED），
 * 系统里没有「审核/驳回」这一步，所以这里不提供审核按钮。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchPoolBalances, type PoolBalance, type SessionUser } from "../../api";
import { money } from "../../labels";
import { can } from "../../perm";
import { goBack, navigate } from "../../router";
import { DepositsTab } from "./tabs/DepositsTab";
import { FlowsTab } from "./tabs/FlowsTab";
import { PoolsTab } from "./tabs/PoolsTab";
import { ReconTab } from "./tabs/ReconTab";

export type FundsTabKey = "flows" | "pools" | "reconciliations" | "deposits";

const TABS: { key: FundsTabKey; label: string }[] = [
  { key: "flows", label: "流水" },
  { key: "pools", label: "账户" },
  { key: "reconciliations", label: "对账" },
  { key: "deposits", label: "押金" },
];

const TAB_PATH: Record<FundsTabKey, string> = {
  flows: "/funds",
  pools: "/funds/pools",
  reconciliations: "/funds/reconciliations",
  deposits: "/funds/deposits",
};

/** 每个子页头部的动作按钮：入口跟着页走，避免出现"点进去才发现不能做"。 */
const TAB_ACTION: Record<FundsTabKey, { label: string; to: string; permission: string }> = {
  flows: { label: "记一笔", to: "/funds/cashflows/new", permission: "deposit.post" },
  pools: { label: "划转", to: "/funds/transfers/new", permission: "finance.transfer" },
  reconciliations: { label: "新建对账", to: "/funds/reconciliations/new", permission: "deposit.post" },
  deposits: { label: "交押金", to: "/funds/deposits/new", permission: "deposit.post" },
};

const TAB_HINT: Record<FundsTabKey, string> = {
  flows: "池内全部收支流水",
  pools: "账户余额与可用资金",
  reconciliations: "日终账面与实盘核对",
  deposits: "押金收退与损失",
};

export function FundsPage({ tab, user }: { tab: FundsTabKey; user: SessionUser | null }) {
  const [pools, setPools] = useState<PoolBalance[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchPoolBalances()
      .then((rows) => {
        if (alive) setPools(rows);
      })
      .catch((issue: Error) => {
        if (alive) setError(issue.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  const totals = useMemo(
    () => ({
      available: pools.reduce((sum, pool) => sum + Number(pool.available ?? 0), 0),
      cash: pools.reduce((sum, pool) => sum + Number(pool.cash_balance ?? 0), 0),
      deposit: pools.reduce((sum, pool) => sum + Number(pool.deposit_held ?? 0), 0),
    }),
    [pools],
  );

  const action = TAB_ACTION[tab];

  const body = useCallback(() => {
    switch (tab) {
      case "pools":
        return <PoolsTab />;
      case "reconciliations":
        return <ReconTab user={user} />;
      case "deposits":
        return <DepositsTab user={user} />;
      default:
        return <FlowsTab user={user} />;
    }
  }, [tab, user]);

  return (
    <div className="h5-page">
      <header className="h5-pagehead">
        {/* 资金不占底栏，属二级页面：必须自带返回，否则从「我的」进来就出不去。 */}
        <button type="button" className="h5-pagehead__back" onClick={() => goBack("/mine")}>
          ‹ 返回
        </button>
        <div className="h5-pagehead__row">
          <div>
            <h1>资金</h1>
            <p>{TAB_HINT[tab]}</p>
          </div>
          {can(user, action.permission) ? (
            <button type="button" className="h5-pagehead__action" onClick={() => navigate(action.to)}>
              {action.label}
            </button>
          ) : null}
        </div>
      </header>

      <section className="h5-balance" aria-label="资金总览">
        <div className="h5-balance__top">
          <span>可用资金</span>
          <span className="h5-balance__badge">{pools.length} 个账户</span>
        </div>
        <p className="h5-balance__value">
          <small>¥</small>
          {money(totals.available)}
        </p>
        <div className="h5-balance__split">
          <div>
            <span>现金头寸</span>
            <strong>¥{money(totals.cash)}</strong>
          </div>
          <div>
            <span>押金占用</span>
            <strong>¥{money(totals.deposit)}</strong>
          </div>
        </div>
      </section>

      {error ? <div className="h5-alert h5-alert--error" role="alert">{error}</div> : null}

      <div className="h5-toolbar h5-toolbar--plain">
        <div className="h5-chips" role="tablist" aria-label="资金分类">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={`h5-chip${tab === item.key ? " is-active" : ""}`}
              onClick={() => navigate(TAB_PATH[item.key], true)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {body()}
    </div>
  );
}
