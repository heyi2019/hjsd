/** 编号序列（foundation/sequences）：12 个编号域的当前值与下一编号，只读。
 *  用于断号 / 跳号 / 重号排查——编号由后端统一发放，本面板不提供任何写入口。 */
import { configurableLabel } from "../../shared/lib/optionSets";
import { Card, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { sequencesApi, type DocumentSequence } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { DataTable, ErrorBanner } from "../../shared/ui";

const SEQUENCE_KEY_LABEL: Record<string, string> = {
  ORDER_HS: "回收订单",
  ORDER_TH: "提号订单",
  ORDER_DG: "代挂订单",
  ORDER_DFQ: "代分期订单",
  CUSTOMER: "客户",
  COUNTERPARTY: "合作方",
  LEAD: "需求",
  QUALITY_ISSUE: "质量工单",
  NOTIFICATION: "通知",
  CASHFLOW: "资金流水",
  IMPORT: "导入批次",
  ATTACHMENT: "附件",
};

export function SequencesPanel() {
  const [rows, setRows] = useState<DocumentSequence[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await sequencesApi.list());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<DocumentSequence> = [
    { title: "编号域", dataIndex: "sequence_key", render: (v: string) => configurableLabel("SEQUENCE_KEY", v, SEQUENCE_KEY_LABEL) },
    { title: "序列键", dataIndex: "sequence_key" },
    { title: "前缀", dataIndex: "prefix", render: (v: string) => v || "—" },
    { title: "补齐位数", dataIndex: "padding", align: "right" },
    { title: "当前值", dataIndex: "current_value", align: "right" },
    { title: "下一编号", dataIndex: "next_number" },
  ];

  return (
    <Card className="glass" title="编号序列">
      <ErrorBanner error={error} onRetry={() => void load()} retrying={loading} />
      <Typography.Paragraph type="secondary" className="ui-card-hint">
        编号由后端按域独立发放，本面板只读。排查断号 / 跳号时对照「当前值」与业务单据最大编号：不一致说明存在发放失败或手工补号，需复查对应批次的导入与冲销记录。
      </Typography.Paragraph>
      <DataTable<DocumentSequence>
        columns={columns}
        rows={rows}
        page={1}
        pageSize={20}
        total={rows.length}
        emptyText="暂无编号序列"
        loading={loading}
        onPageChange={() => undefined}
     />
    </Card>
  );
}
