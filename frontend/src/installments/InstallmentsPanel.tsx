/** 分期：按业务合约类型分列，展示库存分期出售与代分期的收款、交付和风险处理。
 * 收款必须选择首付或期次；未结清不可换绑交付。 */
import { Button, Card, Segmented, Space, Tabs, Typography } from "antd";
import { appMessage } from "../shared/ui/appFeedback";
import { useState } from "react";
import { installmentsApi, type Installment, type Schedule } from "../shared/api/catalog";
import { today } from "../shared/lib/format";
import { configurableLabel } from "../shared/lib/optionSets";
import { DataTable, ErrorBanner, PermissionButton, StatRow } from "../shared/ui";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";


import { CONTRACT_TYPE_LABEL, DISPOSITION_LABEL, MobileInstallmentList } from "./InstallmentsPanel.fragments";
import { useContractTableController } from "./useContractTableController";
import { ContractModals } from "./InstallmentsPanel.modals";

function ContractTable({
  contractType,
  reloadKey,
}: {
  contractType: string;
  reloadKey: number;
}) {
  const controller = useContractTableController({ contractType, reloadKey });
  const {
    arrangeColumns,
    cancelForm,
    columns,
    compact,
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
  } = controller;
  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />

      <StatRow
        items={[
          { label: "合约数", kind: "count", amount: String(rows.length) },
          { label: "总应收", amount: totalReceivable },
          { label: "已收合计", amount: totalPaid },
          {
            label: "逾期合约",
            kind: "count",
            amount: String(rows.filter((r) => r.status === "OVERDUE").length),
            tone: rows.some((r) => r.status === "OVERDUE") ? "warn" : "plain",
          },
        ]}
      />

      <Card
        className="glass"
        extra={
          <Space size={8}>
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
        {compact ? (
          <MobileInstallmentList
            rows={[...rows].sort((a, b) => (sortDesc ? b.id - a.id : a.id - b.id))}
            orders={orders}
            dispositions={dispositions}
            settlePermission={settlePermission}
            onPay={(row) => { payForm.resetFields(); setPayTarget(row); payForm.setFieldsValue({ paid_on: today() }); }}
            onDeliver={openDeliver}
            onRecover={(row) => { recoverForm.resetFields(); setRecoverTarget(row); recoverForm.setFieldsValue({ occurred_on: today() }); }}
            onRefund={(row) => { cancelForm.resetFields(); setCancelTarget(row); cancelForm.setFieldsValue({ cancelled_on: today() }); }}
            onSettle={(row) => { settleForm.resetFields(); setSettleTarget(row); settleForm.setFieldsValue({ paid_on: today() }); }}
            onDefault={(row) => { defaultForm.resetFields(); setDefaultTarget(row); }}
            onResale={(row) => { resaleForm.resetFields(); setResaleTarget(row); resaleForm.setFieldsValue({ occurred_on: today() }); }}
          />
        ) : (
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
        )}
      </Card>

      <ContractModals controller={controller} />








    </section>
  );
}


export function InstallmentsPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [reloadKey, setReloadKey] = useState(0);
  const write = useAsyncAction();
  // refreshKey：外部建单（如代分期建单生成新合约）后由上层递增，触发合约列表重拉。
  // 逾期标记是全局动作（后端按 as_of 扫描全部合约），故放在 Tab 外层并触发全量刷新。
  const runMarkOverdue = async () => {
    await write.run(async () => {
      const result = await installmentsApi.markOverdue();
      appMessage.success(
        result.marked > 0 ? `已标记 ${result.marked} 笔逾期` : "当前无新增逾期合约",
      );
      setReloadKey((key) => key + 1);
    });
  };
  return (
    <Tabs
      defaultActiveKey="stock"
      tabBarExtraContent={
        <Space>
          <PermissionButton permission="order.event.post" size="small" loading={write.pending} onClick={() => void runMarkOverdue()}>
            标记逾期
          </PermissionButton>
          <PermissionButton permission="finance.read" size="small" onClick={() => setReloadKey((key) => key + 1)}>
            刷新
          </PermissionButton>
        </Space>
      }
      items={[
        {
          key: "stock",
          label: configurableLabel("INSTALLMENT_CONTRACT_TYPE", "STOCK_SALE", CONTRACT_TYPE_LABEL),
          children: <ContractTable contractType="STOCK_SALE" reloadKey={reloadKey + refreshKey} />,
        },
        {
          key: "advance",
          label: configurableLabel("INSTALLMENT_CONTRACT_TYPE", "ADVANCE_PURCHASE", CONTRACT_TYPE_LABEL),
          children: <ContractTable contractType="ADVANCE_PURCHASE" reloadKey={reloadKey + refreshKey} />,
        },
      ]}
    />
  );
}

