import { TimeOrderControl } from "../../shared/ui/TimeOrderControl";
/** 分期：按业务合约类型分列，展示库存分期出售的收款、交付和风险处理。
 * 收款必须选择首付或期次；未结清不可换绑交付。 */
import { Card, DatePicker, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import type { Dayjs } from "dayjs";
import { installmentsApi } from "../../shared/api/installments.api";
import type { Installment, Schedule } from "../../shared/api/types/installments";
import { INSTALLMENT_STATUS_LABEL, today } from "../../shared/lib/format";
import { configurableLabel } from "../../shared/lib/optionSets";
import { DataTable, ErrorBanner, ExportButton, PermissionButton, Select, StatRow } from "../../shared/ui";


import { DISPOSITION_LABEL } from "./InstallmentsPanel.fragments";
import { useContractTableController } from "./useContractTableController";
import { ContractModals } from "./InstallmentsPanel.modals";

function ContractTable({
  contractType,
  reloadKey,
  active,
  initialStatus,
}: {
  contractType: string;
  reloadKey: number;
  active: boolean;
  initialStatus?: string;
}) {
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [status, setStatus] = useState(initialStatus);
  useEffect(() => { setStatus(initialStatus); }, [initialStatus]);
  const controller = useContractTableController({
    contractType,
    reloadKey,
    active,
    status,
    dateRange: dateRange ? [dateRange[0].format("YYYY-MM-DD"), dateRange[1].format("YYYY-MM-DD")] : null,
  });
  const {
    arrangeColumns,
    cancelForm,
    columns,
    defaultForm,
    error,
    listError,
    exportCsv,
    exporting,
    load,
    loading,
    totalsLoading,
    totalsError,
    openDeliver,
    page,
    pageSize,
    pageTotal,
    payForm,
    recoverForm,
    rows,
    scheduleColumns,
    setCancelTarget,
    setDefaultTarget,
    setPayTarget,
    setPage,
    setPageSize,
    setRecoverTarget,
    setSettleTarget,
    setSortDesc,
    settleForm,
    settlePermission,
    sortDesc,
    totalPaid,
    totalReceivable,
    totalCount,
    overdueCount,
    employees,
    updateOperationOperators,
  } = controller;
  const employeeNames = new Map(employees.map((employee) => [employee.id, employee.display_name]));
  const operationLabel = (key: string) => {
    const [action, period] = key.split(":");
    const label: Record<string, string> = {
      CREATE: "建单",
      PAY: "收款",
      DELIVER: "交付",
      RECOVER: "回收",
      RESELL: "转售",
      CANCEL: "终止",
      SETTLE: "提前结清",
      DEFAULT: "标记坏账",
      WAIVE: "减免",
      EXTEND: "展期",
    };
    return period ? `${label[action] ?? action}（${period}）` : label[action] ?? action;
  };
  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />
      <ErrorBanner error={totalsError ? { ...totalsError, message: `合计加载失败：${totalsError.message}` } : null} onRetry={() => void load()} />

      <Card className="glass" title="分期与回款">
          <Space size={8} wrap className="ui-filter-bar ui-filter-bar--spaced">
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
            {status ? <Space size={4}>
              <Typography.Text>合约状态：{configurableLabel("INSTALLMENT_STATUS", status, INSTALLMENT_STATUS_LABEL)}</Typography.Text>
              <Typography.Link role="button" tabIndex={0} onClick={() => setStatus(undefined)} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setStatus(undefined); }
              }}>查看全部合约</Typography.Link>
            </Space> : null}
            <TimeOrderControl descending={sortDesc} onChange={setSortDesc} />
            <ExportButton
              aria-label="导出分期与回款数据"
              loading={exporting}
              onClick={() => void exportCsv()}
            />
          </Space>
        <StatRow
          items={[
            { label: "合约数", kind: "count", amount: totalsLoading || totalsError ? null : String(totalCount) },
            { label: "总应收", amount: totalsLoading || totalsError ? null : totalReceivable },
            { label: "已收合计", amount: totalsLoading || totalsError ? null : totalPaid },
            {
              label: "逾期合约",
              kind: "count",
              amount: totalsLoading || totalsError ? null : String(overdueCount),
              tone: !totalsLoading && !totalsError && overdueCount > 0 ? "warn" : "plain",
            },
          ]}
        />
        <DataTable<Installment>
          columns={arrangeColumns(columns)}
          rows={rows}
          loading={loading}
          page={page}
          pageSize={pageSize}
          total={pageTotal}
          controlledPaging
          emptyText={listError ? "分期合约数据不可用，请点击重新加载" : "暂无分期合约"}
          pagination={listError ? false : undefined}
          onPageChange={(nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); }}
          expandable={{
            expandedRowRender: (row) => {
              const operationOperators = row.operation_operators ?? [];
              return (
                <Space direction="vertical" size="middle" className="installment-detail-stack">
                <DataTable<Schedule>
                rows={row.schedules}
                page={1}
                pageSize={20}
                total={row.schedules.length}
                onPageChange={() => undefined}
                emptyText="暂无期次"
                columns={scheduleColumns}
              />
              {operationOperators.length > 0 && (
                <div>
                  <Typography.Text strong>动作操作人</Typography.Text>
                  <DataTable
                    rows={operationOperators}
                    page={1}
                    pageSize={20}
                    total={operationOperators.length}
                    onPageChange={() => undefined}
                    pagination={false}
                    rowKey="operation_key"
                    size="small"
                    columns={[
                      { title: "动作", dataIndex: "operation_key", key: "operation_key", render: (value: string) => operationLabel(value) },
                      {
                        title: "操作人",
                        dataIndex: "operator_user_ids",
                        key: "operator_user_ids",
                        render: (ids: number[], operation) => (
                          <Select
                            mode="multiple"
                            showSearch
                            optionFilterProp="label"
                            aria-label={`编辑${operationLabel(operation.operation_key)}操作人`}
                            value={ids}
                            options={employees.map((employee) => ({ value: employee.id, label: employee.display_name }))}
                            onChange={(next) => void updateOperationOperators(row.id, operation.operation_key, next as number[])}
                          />
                        ),
                      },
                      { title: "动作时间", dataIndex: "occurred_at", key: "occurred_at" },
                    ]}
                  />
                </div>
              )}
              {row.dispositions.length > 0 && (
                <Typography.Paragraph>
                  处置记录：{row.dispositions.map((item) =>
                    `${configurableLabel("INSTALLMENT_DISPOSITION", item.action, DISPOSITION_LABEL)}（${item.occurred_on}）`,
                  ).join("、")}
                </Typography.Paragraph>
              )}
                </Space>
              );
            },
        }}
      />
      </Card>

      <ContractModals controller={controller} />








    </section>
  );
}


export function InstallmentsPanel({ refreshKey = 0, initialStatus, active = true }: { refreshKey?: number; initialStatus?: string; active?: boolean }) {
  // refreshKey：外部建单/标记逾期生成新合约后由上层递增，触发合约列表重拉。
  // 面板内不再有「刷新/标记逾期」按钮：逾期标记是全局动作，入口在订单页「分期与回款」Tab 右上角。
  return <ContractTable contractType="STOCK_SALE" reloadKey={refreshKey} initialStatus={initialStatus} active={active} />;
}

