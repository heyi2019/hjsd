/** 状态标签：颜色只做辅助，语义由文案与图标承载（a11y 要求）。 */
import { Tag } from "antd";
import { statusColor } from "../lib/format";

const LABELS: Record<string, string> = {
  DRAFT: "草稿",
  ACTIVE: "进行中",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  PENDING: "待结算",
  IN_STOCK: "在库",
  INSTALLMENT: "分期中",
  FOR_SALE: "待售",
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
  RELEASED: "已释放",
  DISABLED: "已停用",
  LINKED: "已关联",
  UNLINKED: "未关联",
  ORPHAN: "孤儿",
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
};

export function StatusTag(props: { status: string; label?: string; color?: string }) {
  return (
    <Tag color={props.color ?? statusColor(props.status)} bordered={false}>
      {props.label ?? LABELS[props.status] ?? props.status}
    </Tag>
  );
}
