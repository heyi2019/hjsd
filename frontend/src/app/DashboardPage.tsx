/** 工作台：今日资金与待办总览（资金池卡片 + TH 未闭环代垫 + 押金占用）。 */
import { Card, Space } from "antd";
import { useCallback, useEffect, useState } from "react";
import { poolsApi, qualityApi, type Pool, type PoolBalance } from "../shared/api/catalog";
import { errorMessage } from "../shared/api/client";
import {
  DataTable,
  MoneyText,
  PageHeader,
  PermissionGate,
  StatRow,
  StatusTag,
} from "../shared/ui";
import type { ColumnsType } from "antd/es/table";

interface PoolRow {
  key: string;
  pool: Pool;
  balance?: PoolBalance;
}

export function DashboardPage() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [balances, setBalances] = useState<Record<number, PoolBalance>>({});
  const [loading, setLoading] = useState(false);
  const [openIssues, setOpenIssues] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await poolsApi.list();
      setPools(list);
      const entries = await Promise.all(
        list.map(async (pool) => [pool.id, await poolsApi.balance(pool.id)] as const),
      );
      setBalances(Object.fromEntries(entries));
    } catch (error) {
      console.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    qualityApi
      .overview()
      .then((ov) => {
        if (!cancelled) setOpenIssues(ov.items.reduce((sum, item) => sum + item.open, 0));
      })
      .catch(() => {
        /* 概览失败不阻断工作台，其余数据仍可用 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows: PoolRow[] = pools.map((pool) => ({ key: pool.code, pool, balance: balances[pool.id] }));

  const sum = (pick: (b?: PoolBalance) => string | undefined) =>
    rows.reduce((acc, row) => acc + Number(pick(row.balance) ?? 0), 0).toFixed(2);

  const totalAvailable = sum((b) => b?.available);
  const totalThAdvance = sum((b) => b?.th_advance);
  const totalDeposit = sum((b) => b?.deposit_held);

  const columns: ColumnsType<PoolRow> = [
    {
      title: "资金池",
      dataIndex: ["pool", "code"],
      render: (_value, row) => `${row.pool.code} · ${row.pool.name}`,
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
      title: "TH 代垫",
      align: "right",
      render: (_value, row) => <MoneyText value={row.balance?.th_advance} />,
    },
    {
      title: "可用余额",
      align: "right",
      render: (_value, row) => <MoneyText value={row.balance?.available} strong />,
    },
  ];

  return (
    <section className="ui-stack">
      <PageHeader
        title="今日总览"
        description="现金头寸、可用余额、押金与 TH 代垫分列展示，禁止混用（FIN-01-03）。"
      />

      <StatRow
        items={[
          { label: "可用余额合计", amount: totalAvailable },
          { label: "TH 未闭环代垫", amount: totalThAdvance, tone: "warn" },
          { label: "押金占用", amount: totalDeposit },
        ]}
      />
      <StatRow
        items={[
          { label: "资金池数量", kind: "count", amount: String(pools.length) },
          {
            label: "未闭环异常",
            kind: "count",
            amount: openIssues === null ? "-" : String(openIssues),
            tone: openIssues ? "warn" : "plain",
          },
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
        数据口径与 FIN-01 一致；TH 订单永不进入库存。
      </Space>
    </section>
  );
}
