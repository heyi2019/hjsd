/** 标准导入批次、行、映射预览与对账报告。
 * 由原 shared/api/types.ts 按领域拆分；对外仍从 `./types` 统一导入。
 * 金额一律以字符串传输，前端不做浮点数计算。 */

export interface ImportBatch {
  id: number;
  batch_no: string;
  source_name: string;
  source_kind: string;
  status: string;
  row_count: number;
  unmapped_count: number;
  committed_at?: string | null;
  rolled_back_at?: string | null;
  rolled_back_by?: string | null;
  rollback_reason?: string | null;
  corrects_batch_id?: number | null;
  note?: string | null;
}

export interface ImportRow {
  id: number;
  batch_id: number;
  row_no: number;
  raw: Record<string, unknown>;
  mapped_order_id?: number | null;
  mapped_account_id?: number | null;
  mapped_by?: string | null;
  mapped_at?: string | null;
  mapping_basis?: string | null;
  mapped_before?: Record<string, unknown> | null;
  status: string;
  unlinked_transfer: boolean;
  issue_note?: string | null;
}

export interface MappingPreviewColumn {
  source_column: string;
  target_field?: string | null;
  suggested: boolean;
  present_count: number;
  filled_count: number;
  fill_rate: number;
  samples: string[];
}

export interface MappingPreview {
  batch_id: number;
  batch_no: string;
  source_name: string;
  total_rows: number;
  columns: MappingPreviewColumn[];
  abnormal: { empty_value: number; unmapped: number; missing_core_columns?: string[] };
  blockers: string[];
}

export interface ReconciliationReport {
  batch_id: number;
  batch_no: string;
  source_name: string;
  status: string;
  generated_at: string;
  rows: {
    source_total: number;
    imported: number;
    mapped_not_imported: number;
    unmapped: number;
    skipped: number;
    unlinked_transfer: number;
    unaccounted: number;
  };
  amounts: {
    before: Record<string, string>;
    after: Record<string, string>;
    delta: Record<string, string>;
  };
  funds: { cashflow_written: number; linked_event_cashflow: number; note: string };
  requires_adjudication: boolean;
}
