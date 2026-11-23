import { api, type CacheAwareRequestConfig } from "./client";

export type ImportSection = "details" | "events" | "cashflows" | "rebates";
export type ExistingOrderAction = "skip" | "update";

export interface ImportRow {
  sheet: string;
  row: number;
  order_no: string;
  action: "create" | "update" | "skip" | "error";
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
  created: number;
  updated: number;
  skipped: number;
  events_created: number;
  events_matched: number;
  cashflows_created: number;
  cashflows_matched: number;
  cashflows_renumbered: { source: string; current: string }[];
  rebates_created: number;
  rebates_updated: number;
}

function importForm(file: File, existing: ExistingOrderAction, sections: ImportSection[]): FormData {
  const form = new FormData();
  form.append("file", file);
  form.append("existing", existing);
  for (const section of sections) form.append("sections", section);
  return form;
}

export const orderImportApi = {
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
