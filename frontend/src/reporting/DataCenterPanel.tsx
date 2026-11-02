/** 数据中心：今日资金与业务总览（原工作台数据内容，2026-10-13 迁入「经营中心」Tab）。
 *  现金头寸、可用余额和押金分列展示，禁止混用（FIN-01-03）。 */
import { Card, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { ordersApi, poolsApi, reportsApi, type BusinessPnlReport, type Order, type Pool, type PoolBalance, type PoolBalanceTotals } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { useListViewColumns } from "../shared/lib/listColumns";
import type { BusinessCenterEntryTab } from "../orders/businessCenter";
import {
  DataTable,
  EntryCard,
  EntryRow,
  ErrorBanner,
  MoneyText,
  PermissionGate,
  StatRow,
  StatusTag,
} from "../shared/ui";

interface PoolRow {
  key: string;
  pool: Pool;
  balance?: PoolBalance;
}

export function countOngoingOrders(items: Pick<Order, "status">[]): number {
  return items.filter((order) => ["ACTIVE", "INSTALLMENT"].includes(order.status)).length;
}

export function DataCenterPanel({ onNavigate }: { onNavigate?: (key: string, tab?: BusinessCenterEntryTab) => void }) {
  const [pools, setPools] = useState<Pool[] | null>(null);
  const [balances, setBalances] = useState<Record<number, PoolBalance>>({});
  const [balanceTotals, setBalanceTotals] = useState<PoolBalanceTotals | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [businessPnl, setBusinessPnl] = useState<BusinessPnlReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await poolsApi.list();
      setPools(list);
      // 余额与汇总一次批量取回：原先逐池 N+1，再用浮点把卡片相加算合计。
      const overview = await poolsApi.balances();
      setBalances(
        Object.fromEntries(overview.items.map((item) => [item.pool_id, item])),
      );
      setBalanceTotals(overview.totals);
      // 订单计数与资金总览同源加载：订单接口失败时池数据已落 state，仍可渲染，
      // 错误经同一 ErrorBanner 露出，不静默显示 0。
      setOrders(await ordersApi.list());
      setBusinessPnl(await reportsApi.businessPnl());
      setLoadError(null);
    } catch (error) {
      // 必须落到 UI：后端不可达时若只 console.error，页面会静默显示
      // 「资金池数量 0 / 尚未配置资金池」，与「真的没有数据」无法区分。
      setLoadError(normalizeError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows: PoolRow[] = (pools ?? []).map((pool) => ({ key: pool.code, pool, balance: balances[pool.id] }));

  // 合计取服务端（Decimal），前端不再对卡片浮点累加。
  const totalAvailable = pools === null ? "不可用" : balanceTotals?.available ?? "—";
  const totalDeposit = pools === null ? "不可用" : balanceTotals?.deposit_held ?? "—";

  // 业务计数口径：ACTIVE 表示进行中。
  const activeCount = orders === null ? null : countOngoingOrders(orders);
  const orderCardsUnavailable = orders === null;

  const { arrange: arrangeColumns } = useListViewColumns("POOL_BALANCE");
  const columns: ColumnsType<PoolRow> = [
    {
      title: "资金池",
      key: "pool_code",
      className: "ui-col-wrap",
      onCell: () => ({ className: "ui-col-wrap" }),
      dataIndex: ["pool", "code"],
      render: (_value, row) => `${row.pool.name}（${row.pool.code}）`,
    },
    {
      title: "状态",
      key: "status",

      dataIndex: ["pool", "status"],
      width: 110,
      render: (status: string) => <StatusTag status={status} />,
    },
    {
      title: "收入",
      key: "income",
      align: "right",
      render: (_value, row) => <MoneyText value={row.balance?.income} />,
    },
    {
      title: "支出",
      key: "expense",
      align: "right",
      render: (_value, row) => <MoneyText value={row.balance?.expense} />,
    },
    {
      title: "押金",
      key: "deposit_held",

      align: "right",
      render: (_value, row) => <MoneyText value={row.balance?.deposit_held} />,
    },
    {
      title: "可用余额",
      key: "available",
      align: "right",
      render: (_value, row) => <MoneyText value={row.balance?.available} strong />,
    },
  ];

  return (
    <section className="ui-stack">
      <ErrorBanner error={loadError} onRetry={() => void load()} retrying={loading} />

      <Typography.Paragraph type="secondary" className="muted">
        现金头寸、可用余额与押金分列展示，禁止混用（FIN-01-03）。
      </Typography.Paragraph>

      <EntryRow>
        <EntryCard
          title="订单总数"
          value={orders === null ? "不可用" : String(orders.length)}
          description="点击进入业务中心 · 订单台账"
          disabled={orderCardsUnavailable}
          onClick={() => onNavigate?.("business", "ledger")}
        />
        <EntryCard
          title="进行中"
          value={activeCount === null ? "不可用" : String(activeCount)}
          description="点击进入业务中心 · 订单台账"
          disabled={orderCardsUnavailable}
          onClick={() => onNavigate?.("business", "ledger")}
        />
      </EntryRow>

      <StatRow
        items={[
          { label: "可用余额合计", amount: totalAvailable },
          { label: "押金占用", amount: totalDeposit },
          { label: "利润", amount: businessPnl?.total.full_income ?? "-", tone: "auto" },
        ]}
      />
      <StatRow
        items={[
          { label: "资金池数量", kind: "count", amount: pools === null ? "不可用" : String(pools.length) },
        ]}
      />

      <PermissionGate permission="finance.read">
        <Card className="glass" title="资金池概览">
          <DataTable<PoolRow>
            columns={arrangeColumns(columns)}
            rows={rows}
            loading={loading}
            page={1}
            pageSize={Math.max(rows.length, 10)}
            total={rows.length}
            rowKey="key"
            emptyText={pools === null ? "资金池数据不可用，请点击重新加载" : "尚未配置资金池"}
            onPageChange={() => undefined}
         />
        </Card>
      </PermissionGate>

      <Space className="muted" size="small">
        数据口径与 FIN-01 一致；提号账号进入库存后参与库存与成本统计。
      </Space>
    </section>
  );
}
