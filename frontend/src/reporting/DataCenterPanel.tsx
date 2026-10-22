/** 数据中心：今日资金与业务总览（原工作台数据内容，2026-10-13 迁入「经营中心」Tab）。
 *  现金头寸、可用余额和押金分列展示，禁止混用（FIN-01-03）。 */
import { Card, Space, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { ordersApi, poolsApi, reportsApi, type BusinessPnlReport, type Order, type Pool, type PoolBalance } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
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

export function DataCenterPanel({ onNavigate }: { onNavigate?: (key: string) => void }) {
  const [pools, setPools] = useState<Pool[]>([]);
  const [balances, setBalances] = useState<Record<number, PoolBalance>>({});
  const [orders, setOrders] = useState<Order[]>([]);
  const [businessPnl, setBusinessPnl] = useState<BusinessPnlReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await poolsApi.list();
      setPools(list);
      const entries = await Promise.all(
        list.map(async (pool) => [pool.id, await poolsApi.balance(pool.id)] as const),
      );
      setBalances(Object.fromEntries(entries));
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

  const rows: PoolRow[] = pools.map((pool) => ({ key: pool.code, pool, balance: balances[pool.id] }));

  const sum = (pick: (b?: PoolBalance) => string | undefined) =>
    rows.reduce((acc, row) => acc + Number(pick(row.balance) ?? 0), 0).toFixed(2);

  const totalAvailable = sum((b) => b?.available);
  const totalDeposit = sum((b) => b?.deposit_held);

  // 业务计数口径：ACTIVE 表示进行中。
  const activeCount = orders.filter((o) => o.status === "ACTIVE").length;

  const columns: ColumnsType<PoolRow> = [
    {
      title: "资金池",
      dataIndex: ["pool", "code"],
      render: (_value, row) => `${row.pool.name}（${row.pool.code}）`,
    },
    {
      title: "状态",
      dataIndex: ["pool", "status"],
      width: 110,
      render: (status: string) => <StatusTag status={status} />,
    },
    {
      title: "收入",
      align: "right",
      render: (_value, row) => <MoneyText value={row.balance?.income} />,
    },
    {
      title: "支出",
      align: "right",
      render: (_value, row) => <MoneyText value={row.balance?.expense} />,
    },
    {
      title: "押金",
      align: "right",
      render: (_value, row) => <MoneyText value={row.balance?.deposit_held} />,
    },
    {
      title: "可用余额",
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
          value={String(orders.length)}
          description="点击进入业务中心 · 业务台账"
          onClick={() => onNavigate?.("business")}
        />
        <EntryCard
          title="进行中"
          value={String(activeCount)}
          description="点击进入业务中心 · 业务台账"
          onClick={() => onNavigate?.("business")}
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
          { label: "资金池数量", kind: "count", amount: String(pools.length) },
        ]}
      />

      <PermissionGate permission="finance.read">
        <Card className="glass" title="资金池概览">
          <DataTable<PoolRow>
            columns={columns}
            rows={rows}
            loading={loading}
            page={1}
            pageSize={Math.max(rows.length, 10)}
            total={rows.length}
            rowKey="key"
            emptyText="尚未配置资金池"
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
