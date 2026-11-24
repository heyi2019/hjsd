/** 编号序列只读面板：展示实际序列和按订单派生的编号规则。 */
import { Descriptions, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback } from "react";
import { sequencesApi } from "../../shared/api/misc.api";
import type { DocumentSequence } from "../../shared/api/types/common";
import { configurableLabel } from "../../shared/lib/optionSets";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { DataTable, ErrorBanner } from "../../shared/ui";

const SEQUENCE_KEY_LABEL: Record<string, string> = {
  STOCK_NO: "库存编号",
  ORDER_HS: "回收编号",
  ORDER_TH: "提号编号",
  ORDER_DG: "代挂编号",
  CUSTOMER: "客户",
  COUNTERPARTY: "合作方",
  LEAD: "需求",
  NOTIFICATION: "通知",
  CASHFLOW_OUT: "支出流水",
  CASHFLOW_IN: "收入流水",
};

const SEQUENCE_GROUPS: Array<{ label: string; keys: string[] }> = [
  { label: "库存", keys: ["STOCK_NO"] },
  { label: "业务订单", keys: ["ORDER_HS", "ORDER_TH", "ORDER_DG"] },
  { label: "档案", keys: ["CUSTOMER", "COUNTERPARTY"] },
  { label: "需求与通知", keys: ["LEAD", "NOTIFICATION"] },
  { label: "资金", keys: ["CASHFLOW_OUT", "CASHFLOW_IN"] },
];

// 历史库可能保留已下线序列；分期合约也不使用独立序列。
const HIDDEN_SEQUENCE_KEYS = new Set(["IMPORT", "QUALITY_ISSUE", "INSTALLMENT", "ATTACHMENT"]);

type SequenceRow = DocumentSequence & { group: string; label: string };

const columns: ColumnsType<SequenceRow> = [
  { title: "分组", dataIndex: "group", key: "group" },
  { title: "编号类别", dataIndex: "label", key: "label" },
  {
    title: "编号格式",
    key: "format",
    render: (_value, row) => row.sequence_key === "NOTIFICATION"
      ? `${row.prefix} + ${row.padding} 位（上限 NTF9999）`
      : `${row.prefix} + 至少 ${row.padding} 位`,
  },
  { title: "当前序列值", dataIndex: "current_value", key: "current_value", align: "right" },
  { title: "预计下一编号", dataIndex: "next_number", key: "next_number" },
];

export function SequencesPanel() {
  const load = useCallback(() => sequencesApi.list(), []);
  const { data: loadedRows, loading, error, reload } = useSettingsResource(load);
  const rows = loadedRows ?? [];
  const notificationSequence = rows.find((row) => row.sequence_key === "NOTIFICATION" && row.near_exhaustion && row.remaining != null);
  const byKey = new Map(rows.map((row) => [row.sequence_key, row]));
  const coveredKeys = new Set(SEQUENCE_GROUPS.flatMap((group) => group.keys));

  const makeRow = (row: DocumentSequence, group: string): SequenceRow => ({
    ...row,
    group,
    label: row.sequence_key === "STOCK_NO"
      ? SEQUENCE_KEY_LABEL.STOCK_NO
      : configurableLabel("SEQUENCE_KEY", row.sequence_key, SEQUENCE_KEY_LABEL),
  });
  const sequenceRows = SEQUENCE_GROUPS.flatMap((group) => group.keys.flatMap((key) => {
    const row = byKey.get(key);
    return row ? [makeRow(row, group.label)] : [];
  }));
  sequenceRows.push(...rows
    .filter((row) => !coveredKeys.has(row.sequence_key) && !HIDDEN_SEQUENCE_KEYS.has(row.sequence_key))
    .map((row) => makeRow(row, "其他／待核对")));

  return (
    <section className="sequences-panel">
      <ErrorBanner error={error} onRetry={() => void reload()} retrying={loading} />
      {notificationSequence && <Typography.Paragraph type="warning">通知编号还剩 {notificationSequence.remaining} 个；用尽后需要生成通知的操作会失败，请联系管理员处理。</Typography.Paragraph>}
      <Typography.Paragraph type="secondary" className="ui-card-hint">
        编号由系统自动生成，页面只读。序列当前值和预计下一编号用于参考；编号可能存在间隔，如需排查，请结合历史导入和业务记录核对。预计下一编号以查询时的数据为准，实际创建时可能已被其他操作占用。
      </Typography.Paragraph>
      {error ? (
        <Typography.Paragraph type="warning">编号序列数据不可用，请点击重新加载</Typography.Paragraph>
      ) : (
        <>
          <DataTable<SequenceRow>
            ariaLabel="编号序列"
            columns={columns}
            rows={sequenceRows}
            rowKey="sequence_key"
            loading={loading}
            page={1}
            pageSize={sequenceRows.length || 1}
            total={sequenceRows.length}
            onPageChange={() => undefined}
            pagination={false}
            emptyText="暂无编号序列"
          />
          <Typography.Paragraph type="secondary" className="ui-card-hint">
            库存编号在新建库存账号时发放，例如普通建单或分期回收形成新库存时。
          </Typography.Paragraph>
          <Typography.Title level={5}>按订单派生的编号</Typography.Title>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="分期合约号">首次为 HS0001-FQ；取消后重新创建可为 HS0001-FQ-02、HS0001-FQ-03。</Descriptions.Item>
            <Descriptions.Item label="返点单号">按订单递增，例如 HS0001-RB01、HS0001-RB02。</Descriptions.Item>
          </Descriptions>
        </>
      )}
    </section>
  );
}
