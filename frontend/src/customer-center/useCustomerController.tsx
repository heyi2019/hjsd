import { Form, Space, Typography } from "antd";
import { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildFormExtraDisplay, formatExtraDisplayValue } from "../business/ConfigurableField";
import { customersApi } from "../shared/api/customers.api";
import { employeesApi } from "../shared/api/org.api";
import { orderFormFieldsApi } from "../shared/api/orders.api";
import type { Customer, CustomerDetail } from "../shared/api/types/customers";
import type { OrderFormField } from "../shared/api/types/forms";
import { normalizeError } from "../shared/api/client";
import { downloadBlob } from "../shared/api/download";
import { formatDateTimeMinute, today } from "../shared/lib/format";
import { useListViewColumns } from "../shared/lib/listColumns";
import { useOptionSet } from "../shared/lib/optionSets";
import { ConfirmButton, PermissionButton, StatusTag } from "../shared/ui";
import { appMessage } from "../shared/ui/appFeedback";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { useLatestRequest } from "../shared/hooks/useLatestRequest";
import { collectExtras } from "./CustomersPage.fragments";
import { loadActiveCustomers } from "./loadActiveCustomers";

/** ≤640px 隐藏：联系方式与建立时间，详情里可看；状态与操作必须常驻。 */
export function useCustomerController({ active = true, focusId, orderFilter, createdPeriod }: { active?: boolean; focusId?: number; orderFilter?: { from?: string; to?: string }; createdPeriod?: { from: string; to: string } | null }) {
  const [rows, setRows] = useState<Customer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<{ month_count: number; today_count: number } | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<{ message: string; code?: string } | null>(null);
  const [fieldDefs, setFieldDefs] = useState<OrderFormField[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Customer | null>(null);
  const [detailTarget, setDetailTarget] = useState<Customer | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Customer | null>(null);
  const [mergeCandidates, setMergeCandidates] = useState<Customer[] | null>(null);
  const [detailData, setDetailData] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [candidateError, setCandidateError] = useState<{ message: string; code?: string } | null>(null);
  const write = useAsyncAction();
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [searchInput, setSearchInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [creatorFilter, setCreatorFilter] = useState<string[]>([]);
  const [creatorOptions, setCreatorOptions] = useState<{ label: string; value: string }[] | null>(null);
  const requestRef = useRef(0);
  const summaryRequestRef = useRef(0);
  const detailRequest = useLatestRequest();
  const customerStatusOptions = useOptionSet("CUSTOMER_STATUS");
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [mergeForm] = Form.useForm();

  const activeDefs = fieldDefs.filter((def) => def.is_active);

  const [exporting, setExporting] = useState(false);
  /** 客户按列配置导出 CSV。 */
  const exportCustomers = async () => {
    setExporting(true);
    try {
      downloadBlob(
        await customersApi.exportCsv({
          ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
          ...(statusFilter ? { status: statusFilter } : {}),
          ...(creatorFilter.length > 0 ? { created_by: creatorFilter } : {}),
          ...(orderFilter ? { mine_orders: true, trade_date_from: orderFilter.from, trade_date_to: orderFilter.to } : {}),
          ...(createdPeriod ? { created_from: createdPeriod.from, created_to: createdPeriod.to } : {}),
        }),
        `客户-${today()}.csv`,
      );
      appMessage.success("客户数据已导出");
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setExporting(false);
    }
  };

  const loadList = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    const params = {
      ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(creatorFilter.length > 0 ? { created_by: creatorFilter } : {}),
      ...(orderFilter ? { mine_orders: true, trade_date_from: orderFilter.from, trade_date_to: orderFilter.to } : {}),
      ...(createdPeriod ? { created_from: createdPeriod.from, created_to: createdPeriod.to } : {}),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    };
    await customersApi.page(params).then((customerPage) => {
      if (request !== requestRef.current) return;
      setRows(customerPage.items);
      setTotal(customerPage.total);
      setError(null);
    }).catch((err) => {
      if (request === requestRef.current) setError(normalizeError(err));
    }).finally(() => {
      if (request === requestRef.current) setLoading(false);
    });
  }, [creatorFilter, keyword, page, pageSize, statusFilter, Boolean(orderFilter), orderFilter?.from, orderFilter?.to, createdPeriod?.from, createdPeriod?.to]);

  const loadSummary = useCallback(async () => {
    const request = ++summaryRequestRef.current;
    setSummaryLoading(true);
    setSummaryError(null);
    const params = {
      today_date: today(),
      ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(creatorFilter.length > 0 ? { created_by: creatorFilter } : {}),
      ...(orderFilter ? { mine_orders: true, trade_date_from: orderFilter.from, trade_date_to: orderFilter.to } : {}),
      ...(createdPeriod ? { created_from: createdPeriod.from, created_to: createdPeriod.to } : {}),
    };
    await customersApi.summary(params).then((customerSummary) => {
      if (request === summaryRequestRef.current) setSummary(customerSummary);
    }).catch((err) => {
      if (request === summaryRequestRef.current) setSummaryError(normalizeError(err));
    }).finally(() => {
      if (request === summaryRequestRef.current) setSummaryLoading(false);
    });
  }, [creatorFilter, keyword, statusFilter, Boolean(orderFilter), orderFilter?.from, orderFilter?.to, createdPeriod?.from, createdPeriod?.to]);
  const load = useCallback(async () => {
    await Promise.all([loadList(), loadSummary()]);
  }, [loadList, loadSummary]);

  const resetKey = JSON.stringify([Boolean(orderFilter), orderFilter?.from, orderFilter?.to, createdPeriod?.from, createdPeriod?.to]);
  const previousResetKey = useRef(resetKey);
  // 周期或订单筛选变化时先回到第一页，避免以旧页码发出无效请求。
  useEffect(() => {
    if (!active) return;
    if (previousResetKey.current !== resetKey) {
      previousResetKey.current = resetKey;
      if (page !== 1) {
        setPage(1);
        return;
      }
    }
    void loadList();
    return () => { requestRef.current += 1; };
  }, [active, loadList, page, resetKey]);
  useEffect(() => {
    if (!active) return;
    void loadSummary();
    return () => { summaryRequestRef.current += 1; };
  }, [active, loadSummary]);

  useEffect(() => {
    // 扩展字段定义来自「客户建档」表单的自定义字段；加载失败不阻断客户页
    orderFormFieldsApi
      .list("CUSTOMER", true)
      .then((rows) => setFieldDefs((rows ?? []).filter((row) => row.is_custom)))
      .catch(() => setFieldDefs([]));
  }, []);

  useEffect(() => {
    Promise.resolve(employeesApi.list())
      .then((items) => setCreatorOptions((items ?? []).filter((item) => item.is_active).map((item) => ({
        label: item.display_name || item.username,
        value: item.username,
      }))))
      .catch(() => setCreatorOptions([]));
  }, []);

  const openDetail = async (row: Customer) => {
    const request = detailRequest.start();
    setDetailTarget(row);
    setDetailData(null);
    setDetailLoading(true);
    try {
      const detail = await customersApi.detail(row.id);
      if (detailRequest.isCurrent(request)) setDetailData(detail);
    } catch (err) {
      if (detailRequest.isCurrent(request)) setError(normalizeError(err));
    } finally {
      if (detailRequest.isCurrent(request)) setDetailLoading(false);
    }
  };

  const openDetailById = async (customerId: number) => {
    const request = detailRequest.start();
    setDetailTarget(null);
    setDetailData(null);
    setDetailLoading(true);
    try {
      const detail = await customersApi.detail(customerId);
      if (!detailRequest.isCurrent(request)) return;
      setDetailTarget(detail.customer);
      setDetailData(detail);
    } catch (err) {
      if (detailRequest.isCurrent(request)) setError(normalizeError(err));
    } finally {
      if (detailRequest.isCurrent(request)) setDetailLoading(false);
    }
  };

  const handledFocusRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active || focusId == null || handledFocusRef.current === focusId) return;
    handledFocusRef.current = focusId;
    void openDetailById(focusId);
  }, [active, focusId]);

  /** 联系方式单元格直接展示已建档原值。 */
  const renderContact = (row: Customer, field: "phone" | "wechat" | "qq") => {
    return row[field] || "-";
  };

  const submitCreate = async (values: Record<string, unknown>) => {
    await write.run(async () => {
      const extraValues = collectExtras(values, activeDefs);
      const result = await customersApi.create({
        display_name: values.display_name as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
        qq: values.qq as string,
        note: (values.note as string) || null,
        extra_values: Object.keys(extraValues).length > 0 ? extraValues : undefined,
      });
      if (result.duplicate_candidates.length > 0) {
        appMessage.warning(`已建档，检测到 ${result.duplicate_candidates.length} 条重复候选（未拦截）`);
      } else {
        appMessage.success("客户已建档");
      }
      setCreateOpen(false);
      form.resetFields();
      await load();
    });
  };

  const submitEdit = async (values: Record<string, unknown>) => {
    if (!editTarget) return;
    await write.run(async () => {
      const extraValues = collectExtras(values, activeDefs, { includeEmpty: true });
      await customersApi.patch(editTarget.id, {
        display_name: values.display_name as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
        qq: values.qq as string,
        note: (values.note as string) || null,
        extra_values: extraValues,
      });
      appMessage.success("客户已更新");
      setEditTarget(null);
      editForm.resetFields();
      await load();
    });
  };

  const submitMerge = async (values: Record<string, unknown>) => {
    if (!mergeTarget) return;
    await write.run(async () => {
      await customersApi.merge(
        mergeTarget.id,
        Number(values.target_customer_id),
        values.reason as string,
      );
      appMessage.success("合并完成，来源客户已置 MERGED 并迁移关联关系");
      setMergeTarget(null);
      mergeForm.resetFields();
      await load();
    });
  };

  const { arrange: arrangeColumns } = useListViewColumns("CUSTOMER");
  const columns: ColumnsType<Customer> = [
    {
      title: "客户编号",
      dataIndex: "customer_no",
      render: (value: string, row) => (
        <Typography.Link
          href="#"
          onClick={(event) => {
            event.preventDefault();
            void openDetail(row);
          }}
        >
          {value}
        </Typography.Link>
      ),
    },
    { title: "名字", dataIndex: "display_name" },
    { title: "手机", key: "phone", render: (_v, row) => renderContact(row, "phone") },
    { title: "微信", key: "wechat", render: (_v, row) => renderContact(row, "wechat") },
    { title: "QQ", key: "qq", render: (_v, row) => renderContact(row, "qq") },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} optionSet="CUSTOMER_STATUS" /> },
    { title: "建立时间", dataIndex: "created_at", render: (v: string | null | undefined) => formatDateTimeMinute(v) },
    { title: "创建操作人", dataIndex: "created_by", render: (v: string | null | undefined) => v || "-" },
    {
      title: "扩展字段",
      key: "extra_values",
      render: (_v, row) => {
        const items = buildFormExtraDisplay(row.extra_values, fieldDefs);
        if (items.length === 0) return "-";
        const shown = items.slice(0, 2).map((it) =>
          `${it.label}${it.status === "deleted" ? "（已删除）" : it.status === "inactive" ? "（已停用）" : ""}：${formatExtraDisplayValue(it.value)}`);
        return items.length > 2 ? `${shown.join("；")} 等 ${items.length} 项` : shown.join("；");
      },
    },
    {
      title: "操作",
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton permission="customer.read" size="small" onClick={() => void openDetail(row)}>
            详情
          </PermissionButton>
          {/* 已合并为终态：仅保留详情入口，不再暴露合并 / 拉黑 / 解除拉黑，避免误判终态可再次流转（L1595）。 */}
          {row.status !== "MERGED" && (
            <>
              <PermissionButton
                permission="customer.merge"
                size="small"
                disabled={row.status !== "ACTIVE"}
                onClick={() => requestMerge(row)}
              >
                合并
              </PermissionButton>
              <ConfirmButton
                permission="customer.update"
                size="small"
                title={row.status === "ACTIVE" ? "拉黑该客户" : "解除拉黑"}
                description={row.status === "ACTIVE"
                  ? "拉黑后不可作为新订单参与方；历史订单、分期与需求保留。"
                  : "解除后可重新作为新订单参与方。"}
                danger={row.status === "ACTIVE"}
                onConfirm={async () => {
                  await customersApi.setStatus(row.id, row.status === "ACTIVE" ? "DISABLED" : "ACTIVE");
                  appMessage.success(row.status === "ACTIVE" ? "客户已拉黑，历史关系保留" : "客户已解除拉黑");
                  await load();
                }}
              >
                {row.status === "ACTIVE" ? "拉黑" : "解除拉黑"}
              </ConfirmButton>
            </>
          )}
        </Space>
      ),
    },
  ];

  const newThisMonthCount = summary?.month_count;
  const newTodayCount = summary?.today_count;
  // —— 弹窗收口：原 JSX 内联的状态更新收为方法，供展示组件回调（语义逐字等价）——
  const clearActionError = () => { write.clearError(); setCandidateError(null); };
  const cancelEdit = () => { clearActionError(); setEditTarget(null); editForm.resetFields(); };
  const closeDetail = () => { detailRequest.invalidate(); setDetailTarget(null); setDetailData(null); setDetailLoading(false); };
  const requestEdit = (target: Customer) => { detailRequest.invalidate(); clearActionError(); setEditTarget(target); setDetailTarget(null); setDetailLoading(false); };
  // 合并弹窗复用同一 Form 实例：取消或再次打开都必须清空，避免上次选的目标客户与原因残留
  // 导致把 A 客户误合并到 B 客户上次选的目标上（#13）。
  const cancelMerge = () => { clearActionError(); setMergeTarget(null); setMergeCandidates(null); mergeForm.resetFields(); };
  const requestMerge = async (target: Customer) => {
    clearActionError();
    mergeForm.resetFields();
    setMergeTarget(target);
    setMergeCandidates(null);
    try {
      setMergeCandidates(await loadActiveCustomers());
    } catch (err) {
      setCandidateError(normalizeError(err));
      setMergeCandidates([]);
    }
  };

  return {
    activeDefs,
    actionError: write.error ?? candidateError,
    actionPending: write.pending,
    arrangeColumns,
    cancelEdit,
    cancelMerge,
    closeDetail,
    clearActionError,
    columns,
    createOpen,
    customerStatusOptions,
    creatorFilter,
    creatorOptions,
    detailData,
    detailLoading,
    detailTarget,
    editForm,
    editTarget,
    error,
    exportCustomers,
    exporting,
    fieldDefs,
    form,
    keyword,
    load,
    loading,
    mergeForm,
    mergeCandidates,
    mergeTarget,
    newThisMonthCount,
    newTodayCount,
    page,
    pageSize,
    renderContact,
    requestEdit,
    requestMerge,
    rows,
    summary,
    summaryLoading,
    summaryError,
    searchInput,
    setCreateOpen,
    setCreatorFilter,
    setKeyword,
    setPage,
    setPageSize,
    setSearchInput,
    setStatusFilter,
    statusFilter,
    submitCreate,
    submitEdit,
    submitMerge,
    total,
  };
}
