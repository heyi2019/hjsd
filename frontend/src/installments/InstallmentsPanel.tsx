/** 分期：按业务合约类型分列，展示库存分期出售的收款、交付和风险处理。
 * 收款必须选择首付或期次；未结清不可换绑交付。 */
import { Button, Card, DatePicker, Segmented, Space, Typography } from "antd";
import { useState } from "react";
import type { Dayjs } from "dayjs";
import { installmentsApi } from "../shared/api/installments.api";
import type { Installment, Schedule } from "../shared/api/types/installments";
import { today } from "../shared/lib/format";
import { configurableLabel } from "../shared/lib/optionSets";
import { DataTable, ErrorBanner, PermissionButton, StatRow } from "../shared/ui";


import { DISPOSITION_LABEL } from "./InstallmentsPanel.fragments";
import { useContractTableController } from "./useContractTableController";
import { ContractModals } from "./InstallmentsPanel.modals";

function ContractTable({
  contractType,
  reloadKey,
}: {
  contractType: string;
  reloadKey: number;
}) {
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  const controller = useContractTableController({
    contractType,
    reloadKey,
    dateRange: dateRange ? [dateRange[0].format("YYYY-MM-DD"), dateRange[1].format("YYYY-MM-DD")] : null,
  });
  const {
    arrangeColumns,
    cancelForm,
    columns,
    defaultForm,
    dispositions,
    error,
    exportCsv,
    exporting,
    load,
    loading,
    openDeliver,
    orders,
    payForm,
    recoverForm,
    resaleForm,
    rows,
    scheduleColumns,
    schedules,
    setCancelTarget,
    setDefaultTarget,
    setPayTarget,
    setRecoverTarget,
    setResaleTarget,
    setSettleTarget,
    setSortDesc,
    settleForm,
    settlePermission,
    sortDesc,
    totalPaid,
    totalReceivable,
    totalCount,
    overdueCount,
  } = controller;
  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />

      <StatRow
        items={[
          { label: "合约数", kind: "count", amount: String(totalCount) },
          { label: "总应收", amount: totalReceivable },
          { label: "已收合计", amount: totalPaid },
          {
            label: "逾期合约",
            kind: "count",
            amount: String(overdueCount),
            tone: overdueCount > 0 ? "warn" : "plain",
          },
        ]}
      />

      <Card
        className="glass"
        extra={
          <Space size={8}>
            <DatePicker.RangePicker
              aria-label="分期日期区间"
              placeholder={["开始日期", "结束日期"]}
              format="YYYY-MM-DD"
              size="small"
              placement="bottomLeft"
              classNames={{ popup: { root: "compact-date-range-picker" } }}
              value={dateRange}
              onChange={(value) => setDateRange(value?.[0] && value[1] ? [value[0], value[1]] : null)}
            />
            <Typography.Text type="secondary">排序</Typography.Text>
            <Segmented
              aria-label="分期合约排序"
              value={sortDesc ? "desc" : "asc"}
              options={[
                { value: "desc", label: "最新在前" },
                { value: "asc", label: "最旧在前" },
              ]}
              onChange={(value) => setSortDesc(value === "desc")}
            />
            <Button
              size="small"
              aria-label="导出分期与回款CSV"
              loading={exporting}
              onClick={() => void exportCsv()}
            >
              导出 CSV
            </Button>
          </Space>
        }
      >
        <DataTable<Installment>
          columns={arrangeColumns(columns)}
          rows={[...rows].sort((a, b) => (sortDesc ? b.id - a.id : a.id - b.id))}
          loading={loading}
          page={1}
          pageSize={Math.max(rows.length, 10)}
          total={rows.length}
         
          emptyText="暂无分期合约"
          onPageChange={() => undefined}
          expandable={{
            expandedRowRender: (row) => (
              <Space direction="vertical" size="middle" className="installment-detail-stack">
                <DataTable<Schedule>
                rows={schedules[row.id] ?? []}
                page={1}
                pageSize={20}
                total={(schedules[row.id] ?? []).length}
                onPageChange={() => undefined}
                emptyText="暂无期次"
                columns={scheduleColumns}
              />
              {(dispositions[row.id] ?? []).length > 0 && (
                <Typography.Paragraph>
                  处置记录：{(dispositions[row.id] ?? []).map((item) =>
                    `${configurableLabel("INSTALLMENT_DISPOSITION", item.action, DISPOSITION_LABEL)}（${item.occurred_on}）`,
                  ).join("、")}
                </Typography.Paragraph>
              )}
            </Space>
          ),
        }}
      />
      </Card>

      <ContractModals controller={controller} />








    </section>
  );
}


export function InstallmentsPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  // refreshKey：外部建单/标记逾期生成新合约后由上层递增，触发合约列表重拉。
  // 面板内不再有「刷新/标记逾期」按钮：逾期标记是全局动作，入口在订单页「分期与回款」Tab 右上角。
  return <ContractTable contractType="STOCK_SALE" reloadKey={refreshKey} />;
}

