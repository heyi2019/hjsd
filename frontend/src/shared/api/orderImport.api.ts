import { api, type CacheAwareRequestConfig } from "./client";

export type ImportSection = "details" | "events" | "cashflows" | "rebates";
export type ExistingOrderAction = "skip" | "update" | "inventory";

export interface ImportRow {
  sheet: string;
  row: number;
  order_no: string;
  action: "create" | "update" | "inventory" | "skip" | "error";
  errors: string[];
  warnings: string[];
}

export interface ImportPreview {
  rows: ImportRow[];
  available_sections: Record<string, number>;
  selected_sections: ImportSection[];
  detail_errors: { sheet: string; row?: number; message: string }[];
}

export interface ImportResult {
  batch_id: number;
  created: number;
  updated: number;
  skipped: number;
  inventories_created: number;
  events_created: number;
  events_matched: number;
  cashflows_created: number;
  cashflows_matched: number;
  cashflows_renumbered: { source: string; current: string }[];
  rebates_created: number;
  rebates_updated: number;
}

export interface ImportHistory {
  id: number;
  file_name: string;
  actor: string;
  imported_at: string;
  created: number;
  updated: number;
  skipped: number;
  inventories_created: number;
  status: "imported" | "reverted";
  reversible: boolean;
  reason: string | null;
}

function importForm(file: File, existing: ExistingOrderAction, sections: ImportSection[]): FormData {
  const form = new FormData();
  form.append("file", file);
  form.append("existing", existing);
  for (const section of sections) form.append("sections", section);
  return form;
}

export const orderImportApi = {
  history: () => api.get<ImportHistory[]>("/order-imports/history").then((response) => response.data),
  revert: (id: number) => api.post<ImportHistory>(`/order-imports/history/${id}/revert`).then((response) => response.data),
  template: (sections: ImportSection[]) => {
    const config: CacheAwareRequestConfig = {
      params: { sections }, paramsSerializer: { indexes: null }, responseType: "blob", bypassCache: true,
    };
    return api.get<Blob>("/order-imports/template.xlsx", config).then((response) => response.data);
  },
  preview: (file: File, existing: ExistingOrderAction, sections: ImportSection[]) =>
    api.post<ImportPreview>("/order-imports/preview", importForm(file, existing, sections)).then((response) => response.data),
  execute: (file: File, existing: ExistingOrderAction, sections: ImportSection[]) =>
    api.post<ImportResult>("/order-imports/execute", importForm(file, existing, sections), { timeout: 120_000 }).then((response) => response.data),
};
