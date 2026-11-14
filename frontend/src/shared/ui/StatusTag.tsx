/** 状态标签：颜色只做辅助，语义由文案与图标承载（a11y 要求）。 */
import { Tag } from "antd";
import { statusColor } from "../lib/format";
import { useOptionSet } from "../lib/optionSets";

const LABELS: Record<string, string> = {
  DRAFT: "草稿",
  ACTIVE: "进行中",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  PENDING: "待结算",
  WAITING: "待售",
  IN_STOCK: "在库",
  OUT_OF_STOCK: "出库",
  INSTALLMENT: "分期中",
  SOLD: "已售",
  VOID: "失效",
  OVERDUE: "逾期",
  SETTLED: "已结清",
  DELIVERED: "已交付",
  DEFAULTED: "违约",
  OPEN: "未结算",
  PARTIALLY_SETTLED: "部分结算",
  PAID: "已付",
  RETURNED: "已退",
  PARTIALLY_RETURNED: "部分退还",
  LOST: "已损失",
  RELEASED: "已释放",
  DISABLED: "已停用",
  LINKED: "已关联",
  UNLINKED: "未关联",
  ORPHAN: "孤儿",
  UNLINKED_TRANSFER: "单边划转未关联",
  BLOCKER: "阻断",
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
  ASSIGNED: "已指派",
  RESOLVED: "已处置",
  CLOSED: "已关闭",
  IGNORED: "已忽略",
  // 导入批次 / 行状态（MIG-01）：与后端 ImportBatchStatus / ImportRowStatus 对齐
  UNMAPPED: "未映射",
  ROLLED_BACK: "已回滚",
  CORRECTED: "已更正",
  COMMITTED: "已确认",
  MAPPED: "已映射",
  REJECTED: "已拒绝",
  IMPORTED: "已导入",
  SKIPPED: "已跳过",
  // 经营规则版本状态（PolicyStatus）
  EXPIRED: "已失效",
  SUPERSEDED: "已被取代",
  // 客户需求状态（LeadStatus：OPEN/CLOSED 与对账域共用，仅补 CONVERTED 独有码）
  CONVERTED: "已转化",
  READ: "已读",
  UNREAD: "未读",
};

/**
 * @param optionSet 该状态所属的选项词典 code（如 "INSTALLMENT_STATUS"）。传入后优先用
 *   词典里的 label，实现「设置页改文案 → 表格同步变化」；未传或词典未命中则回落全局
 *   LABELS 映射（T25 前的行为，零回归）。
 */
export function StatusTag(props: { status: string; label?: string; color?: string; optionSet?: string }) {
  // 始终调用 hook（空 code 返回 null），避免条件调用违反 Hooks 规则。
  const options = useOptionSet(props.optionSet ?? "");
  const cfgLabel = options?.find((item) => item.value === props.status)?.label;
  return (
    <Tag color={props.color ?? statusColor(props.status)} bordered={false}>
      {props.label ?? cfgLabel ?? LABELS[props.status] ?? props.status}
    </Tag>
  );
}
