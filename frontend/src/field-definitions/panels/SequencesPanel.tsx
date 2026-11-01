/** 编号序列（foundation/sequences）：各编号域的当前值与下一编号，只读。
 *  展示结构与业务字典一致：一级分组 + 二级条目；用于断号 / 跳号 / 重号排查——
 *  编号由后端统一发放，本面板不提供任何写入口。
 *  用户口径（2026-10-28）：库存编号 / 回收 / 提号 / 代挂 / 分期合约号（关联业务类型）；
 *  库存编号非序列发放域、做一级分组（组级说明），分期合约号缺少后端序列记录时展示静态口径。 */
import { configurableLabel } from "../../shared/lib/optionSets";
import { Card, Descriptions, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { sequencesApi, type DocumentSequence } from "../../shared/api/catalog";
import { normalizeError } from "../../shared/api/client";
import { ErrorBanner } from "../../shared/ui";

const SEQUENCE_KEY_LABEL: Record<string, string> = {
  ORDER_HS: "回收编号",
  ORDER_TH: "提号编号",
  ORDER_DG: "代挂编号",
  INSTALLMENT: "分期合约号",
  CUSTOMER: "客户",
  COUNTERPARTY: "合作方",
  LEAD: "需求",
  QUALITY_ISSUE: "质量工单",
  NOTIFICATION: "通知",
  CASHFLOW_OUT: "支出流水",
  CASHFLOW_IN: "收入流水",
  IMPORT: "导入批次",
  ATTACHMENT: "附件",
};

/** 条目说明前缀：标注分期与业务类型的关联口径。 */
const SEQUENCE_ANNOTATION: Record<string, string> = {
  INSTALLMENT: "关联业务类型（来源回收/提号/代挂订单）",
};

/** 无 document_sequences 行时展示的静态口径条目。 */
const STATIC_ENTRIES: Record<string, { name: string; desc: string }> = {
  INSTALLMENT: {
    name: "分期合约号",
    desc: "编号格式 业务订单编号-FQ",
  },
};

/** 一级分组 → 二级编号域（顺序即展示顺序）。
 *  库存编号为一级分组（用户裁决 2026-10-28）：非序列发放域，仅组级说明、无二级条目。 */
const SEQUENCE_GROUPS: Array<{ label: string; keys: string[]; desc?: string }> = [
  { label: "库存编号", keys: [], desc: "回收/提号/代挂订单建单时自动新增，进入库存中心；不参与序列发放" },
  { label: "业务订单", keys: ["ORDER_HS", "ORDER_TH", "ORDER_DG"] },
  { label: "增值服务", keys: ["INSTALLMENT"] },
  { label: "档案编号", keys: ["CUSTOMER", "COUNTERPARTY"] },
  { label: "运营工单", keys: ["LEAD", "QUALITY_ISSUE", "NOTIFICATION"] },
  { label: "资金与系统", keys: ["CASHFLOW_OUT", "CASHFLOW_IN", "IMPORT", "ATTACHMENT"] },
];

/** 二级条目行：一级条目占多行，每行「加粗名称 + 说明」，不用卡片。 */
function EntryLine({ name, desc }: { name: string; desc: string }) {
  return (
    <div>
      <strong>{name}</strong>：{desc}
    </div>
  );
}

/** 静态口径条目行：名称单独一行，说明另起一行（与序列发放条目区分）。 */
function StaticEntryLine({ name, desc }: { name: string; desc: string }) {
  return (
    <div>
      <div>
        <strong>{name}</strong>
      </div>
      <div>{desc}</div>
    </div>
  );
}

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

  const byKey = new Map(rows.map((row) => [row.sequence_key, row]));
  const describe = (row: DocumentSequence) => {
    const annotation = SEQUENCE_ANNOTATION[row.sequence_key];
    const detail = `编号格式 ${row.prefix}+${row.padding}位流水，当前值 ${row.current_value}，下一编号 ${row.next_number}`;
    return annotation ? `${annotation}；${detail}` : detail;
  };
  const label = (key: string) =>
    key === "INSTALLMENT"
      ? SEQUENCE_KEY_LABEL.INSTALLMENT
      : configurableLabel("SEQUENCE_KEY", key, SEQUENCE_KEY_LABEL);

  const renderEntry = (key: string): JSX.Element | null => {
    const staticEntry = STATIC_ENTRIES[key];
    if (key === "INSTALLMENT" && staticEntry) {
      return <StaticEntryLine key={key} name={staticEntry.name} desc={staticEntry.desc} />;
    }
    const row = byKey.get(key);
    if (row) return <EntryLine key={row.sequence_key} name={label(row.sequence_key)} desc={describe(row)} />;
    return staticEntry ? <StaticEntryLine key={key} name={staticEntry.name} desc={staticEntry.desc} /> : null;
  };

  const items = SEQUENCE_GROUPS.map((group) => {
    const lines = group.keys.map(renderEntry).filter((line): line is JSX.Element => line !== null);
    if (group.desc) lines.unshift(<div key={`${group.label}-desc`}>{group.desc}</div>);
    return lines.length > 0 ? { label: group.label, lines } : null;
  }).filter((item): item is { label: string; lines: JSX.Element[] } => item !== null);

  // 兜底：静态分组未覆盖的动态编号域（如自定义业务订单 ORDER_*）不能静默丢失——
  // 面板用于断号 / 跳号排查，任何发放中的域都必须可见。
  const coveredKeys = new Set(SEQUENCE_GROUPS.flatMap((group) => group.keys));
  const leftover = rows.filter((row) => !coveredKeys.has(row.sequence_key));
  if (leftover.length > 0) {
    items.push({
      label: "自定义编号域",
      lines: leftover.map((row) => <EntryLine key={row.sequence_key} name={label(row.sequence_key)} desc={describe(row)} />),
    });
  }

  return (
    <Card className="glass" title="编号序列">
      <ErrorBanner error={error} onRetry={() => void load()} retrying={loading} />
      <Typography.Paragraph type="secondary" className="ui-card-hint">
        序列编号由后端按域独立发放，本面板只读；库存编号与分期合约号不独立发放，见条目说明。排查断号 / 跳号时对照「当前值」与业务单据最大编号：不一致说明存在发放失败或手工补号，需复查对应批次的导入与冲销记录。
      </Typography.Paragraph>
      {error ? (
        <Typography.Paragraph type="warning">编号序列数据不可用，请点击重新加载</Typography.Paragraph>
      ) : items.length > 0 ? (
        <Descriptions bordered size="small" column={1} labelStyle={{ width: 96 }}>
          {items.map((item) => (
            <Descriptions.Item key={item.label} label={item.label}>
              {item.lines}
            </Descriptions.Item>
          ))}
        </Descriptions>
      ) : (
        <Typography.Paragraph type="secondary">{loading ? "加载中…" : "暂无编号序列"}</Typography.Paragraph>
      )}
    </Card>
  );
}
