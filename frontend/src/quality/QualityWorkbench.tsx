/** 异常工作台（QLT-01）：异常检测 → 工单指派 → 处置闭环 → 审计留痕。 */
import { Card, Select, Space } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import {
  qualityApi,
  type QualityIssue,
  type QualityOverviewItem,
} from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import {
  DataTable,
  ErrorBanner,
  FormDrawer,
  MoneyText,
  PageHeader,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";

/** 异常类型中文名。键必须与后端 app/domain/enums.py 的 IssueType 逐字一致，
 * 漏一个就会在页面上直接露出英文枚举。 */
const ISSUE_TYPE_LABEL: Record<string, string> = {
  UNROUTED_EVENT: "未路由事件",
  SINGLE_SIDED_TRANSFER: "单边划转",
  NEGATIVE_AVAILABLE: "负可用余额",
  TH_UNCLOSED: "TH 未闭环",
  UNCOLLECTED_REBATE: "未归集返点",
  OVERDUE_INSTALLMENT: "分期逾期",
  ACCOUNT_CONFLICT: "账号状态冲突",
  ORPHAN_CASHFLOW: "孤儿流水",
  HISTORY_UNMAPPED: "历史行未映射",
  UNLINKED_TRANSFER: "单边划转未裁决",
};

const SEVERITY_OPTIONS = [
  { value: "BLOCKER", label: "阻断" },
  { value: "HIGH", label: "高" },
  { value: "MEDIUM", label: "中" },
  { value: "LOW", label: "低" },
];

const STATUS_OPTIONS = [
  { value: "OPEN", label: "未处理" },
  { value: "ASSIGNED", label: "已指派" },
  { value: "RESOLVED", label: "已处置" },
  { value: "CLOSED", label: "已关闭" },
  { value: "IGNORED", label: "已忽略" },
];

export function QualityWorkbench() {
  const [overview, setOverview] = useState<QualityOverviewItem[]>([]);
  const [blockers, setBlockers] = useState(0);
  const [rows, setRows] = useState<QualityIssue[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [severity, setSeverity] = useState<string | undefined>(undefined);
  const [issueType, setIssueType] = useState<string | undefined>(undefined);
  const [acting, setActing] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<QualityIssue | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<QualityIssue | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, list] = await Promise.all([
        qualityApi.overview(),
        qualityApi.listIssues({
          status,
          severity,
          issue_type: issueType,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        }),
      ]);
      setOverview(ov.items);
      setBlockers(ov.blockers);
      setRows(list.items);
      // total 取后端筛选后的总数，不是当前页长度，否则分页器会失真
      setTotal(list.total);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, status, severity, issueType]);

  useEffect(() => {
    void load();
  }, [load]);

  const runDetect = useCallback(async () => {
    setActing(true);
    setError(null);
    try {
      await qualityApi.detect();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setActing(false);
    }
  }, [load]);

  const columns: ColumnsType<QualityIssue> = [
    { title: "工单号", dataIndex: "issue_no", width: 130 },
    {
      title: "异常类型",
      dataIndex: "issue_type",
      width: 150,
      render: (value: string) => ISSUE_TYPE_LABEL[value] ?? value,
    },
    {
      title: "严重度",
      dataIndex: "severity",
      width: 90,
      render: (value: string) => <StatusTag status={value} />,
    },
    {
      title: "对象",
      dataIndex: "entity_label",
      render: (value?: string | null) => value ?? "-",
    },
    {
      title: "涉及金额",
      dataIndex: "amount",
      width: 130,
      align: "right",
      render: (value: string) => <MoneyText value={value} />,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 110,
      render: (value: string) => <StatusTag status={value} />,
    },
    {
      title: "操作",
      key: "ops",
      width: 180,
      render: (_value, row) => (
        <Space size="small">
          <PermissionButton
            permission="quality.resolve"
            size="small"
            disabled={row.status === "RESOLVED" || row.status === "CLOSED" || row.status === "IGNORED"}
            onClick={() => setResolveTarget(row)}
          >
            处置
          </PermissionButton>
          <PermissionButton
            permission="quality.resolve"
            size="small"
            danger
            disabled={row.status === "CLOSED" || row.status === "IGNORED"}
            onClick={() => setIgnoreTarget(row)}
          >
            忽略
          </PermissionButton>
        </Space>
      ),
    },
  ];

  return (
    <section className="ui-stack">
      <PageHeader
        title="异常工作台"
        description="系统按固定规则自动检出异常并生成工单；每条工单的处置都写审计日志，不可绕过。"
        actions={
          <PermissionButton
            permission="quality.resolve"
            type="primary"
            loading={acting}
            onClick={() => void runDetect()}
          >
            立即检测
          </PermissionButton>
        }
      />

      <ErrorBanner error={error} />

      <StatRow
        items={[
          { label: "未闭环异常", kind: "count", amount: String(overview.reduce((s, i) => s + i.open, 0)) },
          { label: "阻断级异常", kind: "count", amount: String(blockers), tone: "warn" },
          { label: "已指派", kind: "count", amount: String(overview.reduce((s, i) => s + i.assigned, 0)) },
          { label: "异常总数", kind: "count", amount: String(overview.reduce((s, i) => s + i.total, 0)) },
        ]}
      />

      <Space wrap className="ui-filter-bar">
        <Select
          allowClear
          placeholder="异常类型"
          style={{ width: 180 }}
          value={issueType}
          options={Object.entries(ISSUE_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
          onChange={(value) => {
            setIssueType(value);
            setPage(1);
          }}
        />
        <Select
          allowClear
          placeholder="严重度"
          style={{ width: 130 }}
          value={severity}
          options={SEVERITY_OPTIONS}
          onChange={(value) => {
            setSeverity(value);
            setPage(1);
          }}
        />
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 140 }}
          value={status}
          options={STATUS_OPTIONS}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
      </Space>

      <Card className="glass" title="异常工单列表">
        <DataTable<QualityIssue>
          columns={columns}
          rows={rows}
          loading={loading}
          page={page}
          pageSize={pageSize}
          total={total}
          rowKey="id"
          emptyText="当前筛选条件下没有异常工单"
          onPageChange={(nextPage, nextSize) => {
            setPage(nextPage);
            setPageSize(nextSize);
          }}
        />
      </Card>

      <FormDrawer
        open={resolveTarget !== null}
        title={`处置异常 ${resolveTarget?.issue_no ?? ""}`}
        fields={[
          { name: "resolution", label: "解决方式", required: true, kind: "select" as const, placeholder: "如：已补录流水 / 已释放押金" },
          { name: "note", label: "备注", kind: "textarea" as const },
        ]}
        submitText="确认处置"
        onClose={() => setResolveTarget(null)}
        onSubmit={(values) => {
          const target = resolveTarget;
          if (!target) return;
          setActing(true);
          qualityApi
            .resolve(target.id, {
              resolution: String(values.resolution ?? ""),
              note: values.note ? String(values.note) : undefined,
            })
            .then(() => {
              setResolveTarget(null);
              return load();
            })
            .catch((err) => setError(normalizeError(err)))
            .finally(() => setActing(false));
        }}
      />

      <FormDrawer
        open={ignoreTarget !== null}
        title={`忽略异常 ${ignoreTarget?.issue_no ?? ""}`}
        fields={[{ name: "reason", label: "忽略理由", required: true, kind: "textarea" as const }]}
        submitText="确认忽略"
        onClose={() => setIgnoreTarget(null)}
        onSubmit={(values) => {
          const target = ignoreTarget;
          if (!target) return;
          setActing(true);
          qualityApi
            .ignore(target.id, String(values.reason ?? ""))
            .then(() => {
              setIgnoreTarget(null);
              return load();
            })
            .catch((err) => setError(normalizeError(err)))
            .finally(() => setActing(false));
        }}
      />
    </section>
  );
}

