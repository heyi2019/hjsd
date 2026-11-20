import { api } from "../client";
import { notifyReferenceDataChanged } from "../../state/referenceDataEvents";
import type { FormScope, OrderFormField } from "../types/forms";

function fieldsChanged<T>(value: T): T {
  notifyReferenceDataChanged("formFields");
  return value;
}

function sectionsChanged<T>(value: T): T {
  notifyReferenceDataChanged("formSections");
  return value;
}
export const orderFormFieldsApi = {
  /** 表单作用域注册表（后端单一事实源）。 */
  scopes: () => api.get<FormScope[]>("/order-form-fields/scopes").then((r) => r.data),
  list: (orderTypeCode: string, includeInactive = true) =>
    api
      .get<OrderFormField[]>("/order-form-fields", {
        params: { order_type_code: orderTypeCode, include_inactive: includeInactive },
      })
      .then((r) => r.data),
  create: (payload: Partial<OrderFormField>) =>
    api.post<OrderFormField>("/order-form-fields", payload).then((r) => fieldsChanged(r.data)),
  update: (id: number, payload: Partial<OrderFormField>) =>
    api.patch<OrderFormField>(`/order-form-fields/${id}`, payload).then((r) => fieldsChanged(r.data)),
  setActive: (id: number, active: boolean) =>
    api
      .patch<OrderFormField>(`/order-form-fields/${id}/active?active=${active}`)
      .then((r) => fieldsChanged(r.data)),
  remove: (id: number) => api.delete(`/order-form-fields/${id}`).then(fieldsChanged),
  /** 拉取某业务类型的板块标题覆盖映射（section_key -> 显示标题）。 */
  listSectionLabels: (orderTypeCode: string) =>
    api
      .get<Record<string, string>>("/order-form-fields/section-labels", {
        params: { order_type_code: orderTypeCode },
      })
      .then((r) => r.data),
  /** 保存某业务类型的板块标题覆盖映射（section_key -> 显示标题；空串=恢复默认）。 */
  saveSectionLabels: (payload: { order_type_code: string; labels: Record<string, string> }) =>
    api
      .put<Record<string, string>>("/order-form-fields/section-labels", payload)
      .then((r) => sectionsChanged(r.data)),
  renameSection: (payload: { order_type_code: string; from_key: string; to_key: string; label: string }) =>
    api
      .post<Record<string, string>>("/order-form-fields/section-labels/rename", payload)
      .then((r) => sectionsChanged(fieldsChanged(r.data))),
};
