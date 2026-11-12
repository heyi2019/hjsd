import { api } from "./client";
import type { QualityIssue, QualityMetrics, QualitySummary } from "./types/ops";

export const qualityApi = {
  summary: () => api.get<QualitySummary>("/quality/exceptions").then(r => r.data),
  /** 月度质量指标（对账完成率/分期逾期率/缺附件率）；不传区间时后端只给当月。 */
  metrics: (range?: { from?: string; to?: string }) =>
    api.get<QualityMetrics>("/quality/metrics", { params: range }).then(r => r.data),
  list: () => api.get<{ items: QualityIssue[] }>("/quality/issues").then(r => r.data),
  create: (data: Record<string, unknown>) => api.post<QualityIssue>("/quality/issues", data).then(r => r.data),
  update: (id: number, data: { status: string }) => api.patch<QualityIssue>(`/quality/issues/${id}`, data).then(r => r.data),
  scan: () => api.post<QualityIssue[]>("/quality/scan").then(r => r.data),
  close: (id: number, data: { resolution: string; evidence: string }) => api.post<QualityIssue>(`/quality/issues/${id}/close`, data).then(r => r.data),
  batchClose: (data: { issue_ids: number[]; resolution: string; evidence: string }) => api.post<QualityIssue[]>("/quality/issues/batch-close", data).then(r => r.data),
};
