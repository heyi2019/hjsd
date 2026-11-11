import { Form, Space } from "antd";
import type { UploadFile } from "antd/es/upload/interface";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { importsApi,
  type ImportBatch,
  type ImportRow,
  type MappingPreview,
  type ReconciliationReport, } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { ConfirmButton, PermissionButton, Select, StatusTag } from "../shared/ui";
import { useOptionSet } from "../shared/lib/optionSets";
import { IMPORT_SOURCE_KIND_OPTIONS, type ImportWorkbenchProps } from "./ImportWorkbench.fragments";

/** 导入工作台的全部 state / 派生 / 处理器（含行表格列与批次动作条 JSX）。 */
export function useImportWorkbenchController({
  batchId: batchIdProp,
  onBatchIdChange,
}: ImportWorkbenchProps) {
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [batchesReady, setBatchesReady] = useState(false);
  const sourceKindOptionsRaw = useOptionSet("IMPORT_SOURCE_KIND");
  // 业务字典为空/未就绪时回落到只读集合，避免「数据类型」下拉空白却残留游离默认值（L278）。
  const sourceKindOptions =
    sourceKindOptionsRaw && sourceKindOptionsRaw.length > 0 ? sourceKindOptionsRaw : IMPORT_SOURCE_KIND_OPTIONS;
  const batchStatusOptions = useOptionSet("IMPORT_BATCH_STATUS") ?? [];
  const isBatchControlled = batchIdProp !== undefined;
  const [internalBatchId, setInternalBatchId] = useState<number | null>(null);
  const batchId = isBatchControlled ? (batchIdProp as number | null) : internalBatchId;
  // loadBatches 必须保持 [] 稳定依赖（否则每次选中批次都重拉列表），但它又要判断
  // "当前是否已选批次" 才能决定补选第一个。用 ref 读取最新值，避免永久捕获首次的 null
  // 导致 refreshAll 后把用户当前批次重置回第一个（#12）。
  const batchIdRef = useRef<number | null>(batchId);
  batchIdRef.current = batchId;
  const setBatchId = useCallback(
    (value: number | null) => {
      const next = value ?? null;
      if (!isBatchControlled) setInternalBatchId(next);
      onBatchIdChange?.(next);
    },
    [isBatchControlled, onBatchIdChange],
  );
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [mapTarget, setMapTarget] = useState<ImportRow | null>(null);
  const [unlinkedTarget, setUnlinkedTarget] = useState<ImportRow | null>(null);
  const [skipTarget, setSkipTarget] = useState<ImportRow | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<ImportBatch | null>(null);
  const [rejectTarget, setRejectTarget] = useState<ImportBatch | null>(null);
  const [correctionTarget, setCorrectionTarget] = useState<ImportBatch | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<UploadFile | null>(null);
  const [importing, setImporting] = useState(false);
  const [importForm] = Form.useForm();

  const current = batches.find((b) => b.id === batchId) ?? null;

  const loadBatches = useCallback(async () => {
    setBatchesReady(false);
    try {
      const data = await importsApi.batches();
      setBatches(data.items);
      // 仅当"当前确实还没选中任何批次"时才补选第一个；读 ref 而非闭包捕获的首次 batchId。
      if (batchIdRef.current === null) setBatchId(data.items[0]?.id ?? null);
      setError(null);
      setBatchesReady(true);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  const loadDetail = useCallback(async () => {
    if (batchId === null) {
      setRows([]);
      setPreview(null);
      setReport(null);
      return;
    }
    setLoading(true);
    try {
      const [rowData, previewData, reportData] = await Promise.all([
        importsApi.rows(batchId),
        importsApi.preview(batchId),
        importsApi.reconciliation(batchId),
      ]);
      setRows(rowData.items);
      setPreview(previewData);
      setReport(reportData);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const refreshAll = useCallback(async () => {
    await loadBatches();
    await loadDetail();
  }, [loadBatches, loadDetail]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActing(true);
      setError(null);
      try {
        await fn();
        await refreshAll();
      } catch (err) {
        setError(normalizeError(err));
      } finally {
        setActing(false);
      }
    },
    [refreshAll],
  );

  const canRollback =
    current !== null && ["DRAFT", "MAPPED"].includes(current.status);
  // 已确认批次禁止回滚，只能以更正批次分层保存（MIG-01-08）。
  const canCorrect = current !== null && current.status === "COMMITTED";
  // 驳回仅对未确认批次开放，且为终态：已确认批次只能回滚 / 更正。
  const canReject = canRollback;

  const rowColumns: ColumnsType<ImportRow> = [
    { title: "行号", dataIndex: "row_no", width: 70 },
    {
      title: "原始内容",
      dataIndex: "raw",
      render: (raw: Record<string, unknown>) => (
        <span className="muted">
          {Object.entries(raw)
            .slice(0, 3)
            .map(([key, value]) => `${key}=${String(value).slice(0, 18)}`)
            .join(" · ")}
        </span>
      ),
    },
    { title: "行状态", dataIndex: "status", width: 130, render: (v: string) => <StatusTag status={v} optionSet="IMPORT_ROW_STATUS" /> },
    {
      title: "单边划转",
      dataIndex: "unlinked_transfer",
      width: 100,
      render: (v: boolean) => (v ? <StatusTag status="OVERDUE" label="未裁决" /> : "-"),
    },
    { title: "补录依据", dataIndex: "mapping_basis", width: 140 },
    { title: "补录人", dataIndex: "mapped_by", width: 100 },
    {
      title: "操作",
      width: 220,
      render: (_v, row) => (
        <Space size={2} wrap>
          <PermissionButton
            permission="import.manage"
            size="small"
            disabled={row.status === "ROLLED_BACK"}
            onClick={() => setMapTarget(row)}
          >
            指派
          </PermissionButton>
          <PermissionButton
            permission="import.manage"
            size="small"
            disabled={row.unlinked_transfer || row.status === "ROLLED_BACK"}
            onClick={() => setUnlinkedTarget(row)}
          >
            标单边划转
          </PermissionButton>
          <PermissionButton
            permission="import.manage"
            size="small"
            danger
            disabled={row.status === "ROLLED_BACK"}
            onClick={() => setSkipTarget(row)}
          >
            跳过
          </PermissionButton>
        </Space>
      ),
    },
  ];

  const headerActions = (
    <Space className="ui-filter-bar">
      <PermissionButton
        permission="import.manage"
        type="primary"
        disabled={!batchesReady}
        onClick={() => setImportOpen(true)}
      >
        新建导入
      </PermissionButton>
      <Select
        className="ui-control-width-import"
        aria-label="导入批次"
        value={batchId ?? undefined}
        placeholder="选择导入批次"
        options={batches.map((b) => ({
          value: b.id,
          label: `${b.source_name}（${b.batch_no} · ${batchStatusOptions.find((o) => o.value === b.status)?.label ?? b.status}）`,
        }))}
        onChange={setBatchId}
      />
      <ConfirmButton
        permission="import.manage"
        type="primary"
        danger
        disabled={!canRollback}
        title="确认导入批次"
        description="确认后批次状态将变为「已确认」并锁定映射。确认前请确保所有未映射、未裁决项已处理。"
        okText="确认提交批次"
        onConfirm={async () => {
          if (!current) return;
          await importsApi.commit(current.id);
          await refreshAll();
        }}
      >
        确认批次
      </ConfirmButton>
      <PermissionButton
        permission="import.manage"
        danger
        disabled={!canRollback}
        onClick={() => current && setRollbackTarget(current)}
      >
        回滚
      </PermissionButton>
      <PermissionButton
        permission="import.manage"
        danger
        disabled={!canReject}
        onClick={() => current && setRejectTarget(current)}
      >
        驳回
      </PermissionButton>
      <PermissionButton
        permission="import.manage"
        disabled={!canCorrect}
        onClick={() => current && setCorrectionTarget(current)}
      >
        更正
      </PermissionButton>
    </Space>
  );

  return {
    batches,
    batchesReady,
    setBatches,
    sourceKindOptions,
    batchStatusOptions,
    isBatchControlled,
    internalBatchId,
    setInternalBatchId,
    batchId,
    setBatchId,
    rows,
    setRows,
    preview,
    setPreview,
    report,
    setReport,
    loading,
    setLoading,
    acting,
    setActing,
    error,
    setError,
    mapTarget,
    setMapTarget,
    unlinkedTarget,
    setUnlinkedTarget,
    skipTarget,
    setSkipTarget,
    rollbackTarget,
    setRollbackTarget,
    rejectTarget,
    setRejectTarget,
    correctionTarget,
    setCorrectionTarget,
    importOpen,
    setImportOpen,
    importFile,
    setImportFile,
    importing,
    setImporting,
    importForm,
    current,
    loadBatches,
    loadDetail,
    refreshAll,
    act,
    canRollback,
    canCorrect,
    canReject,
    rowColumns,
    headerActions,
  };
}

export type ImportWorkbenchController = ReturnType<typeof useImportWorkbenchController>;
