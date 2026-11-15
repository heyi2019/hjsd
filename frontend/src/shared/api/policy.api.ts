import { api } from "./client";
import type { PolicyDefinition, PolicyVersion, ProfitAllocation } from "./types/policy";

export const policyApi = {
  list: (params?: { status?: string; policy_code?: string }) =>
    api.get<{ items: PolicyDefinition[]; total: number }>("/policies", { params }).then((r) => r.data),
  create: (payload: { policy_code: string; name: string; scope_type: string; scope_id?: number; description?: string }) =>
    api.post<PolicyDefinition>("/policies", payload).then((r) => r.data),
  versions: (definitionId: number, status?: string) =>
    api.get<{ items: PolicyVersion[]; total: number }>(`/policies/${definitionId}/versions`, { params: { status } }).then((r) => r.data),
  createVersion: (definitionId: number, payload: { effective_from: string; effective_to?: string | null; config: Record<string, unknown>; note?: string }) =>
    api.post<PolicyVersion>(`/policies/${definitionId}/versions`, payload).then((r) => r.data),
  updateDraft: (versionId: number, config: Record<string, unknown>) =>
    api.patch<PolicyVersion>(`/policy-versions/${versionId}`, { config }).then((r) => r.data),
  /** 取消草稿版本（SUPERSEDED）：仅 DRAFT 可取消；已发布版本是历史解析口径，服务端拒绝。 */
  supersede: (versionId: number, payload: { reason: string; replaced_by_version_id?: number }) =>
    api.post<PolicyVersion>(`/policy-versions/${versionId}/supersede`, payload).then((r) => r.data),
  /** 过期清扫：把 effective_to < on 的 ACTIVE 版本固化为 EXPIRED（幂等）。 */
  expireSweep: (on: string) =>
    api
      .post<{ swept: number; version_ids: number[]; on: string }>("/policies/versions/expire-sweep", undefined, {
        params: { on },
      })
      .then((r) => r.data),
  resolve: (policyCode: string, on: string, scope?: { scope_type?: string; scope_id?: number }) =>
    api
      .get<{ found: boolean; version: PolicyVersion | null }>("/policy-versions/resolve", {
        params: { policy_code: policyCode, on, scope_type: scope?.scope_type, scope_id: scope?.scope_id },
      })
      .then((r) => r.data),
  allocations: (orderId: number) =>
    api.get<{ items: ProfitAllocation[]; total: number; order_profit?: string }>(`/orders/${orderId}/profit-allocations`).then((r) => r.data),
  convertAllocation: (orderId: number, direction: "RATE_TO_AMOUNT" | "AMOUNT_TO_RATE", value: string) =>
    api.post<{ value: string | null }>(`/orders/${orderId}/profit-allocations/convert`, { direction, value }).then((r) => r.data),
  setAllocations: (orderId: number, items: { employee_ids?: number[]; user_id?: number | null; role: string; allocation_type?: "BUY" | "SELL" | "OPERATION" | "COMPANY" | "" | null; allocation_rate?: string | null; allocation_amount?: string | null }[], formExtra?: Record<string, unknown>) =>
    api.put<{ items: ProfitAllocation[]; total: number; order_profit?: string }>(`/orders/${orderId}/profit-allocations`, { items, form_extra: formExtra }).then((r) => r.data),
  orderSnapshot: (orderId: number) =>
    api
      .get<{ found: boolean; snapshot: { policy_version_id?: number | null; policy_snapshot?: Record<string, unknown> | null } | null }>(
        `/orders/${orderId}/policy-snapshot`,
      )
      .then((r) => r.data),
};
