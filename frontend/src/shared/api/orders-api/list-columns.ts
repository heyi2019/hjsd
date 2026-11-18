import { api } from "../client";
import type { ListColumnConfig, ListCustomFieldOption, ListScopeConfig } from "../types/forms";

export const listColumnsApi = {
  all: () => api.get<ListScopeConfig[]>("/list-columns").then((r) => r.data),
  save: (
    scope: string,
    items: Array<Pick<ListColumnConfig, "key" | "is_visible" | "sort_order" | "fixed">>,
  ) =>
    api
      .put<ListScopeConfig>(`/list-columns/${scope}`, {
        items: items.map((item) => ({
          column_key: item.key,
          is_visible: item.is_visible,
          sort_order: item.sort_order,
          fixed: item.fixed ?? null,
        })),
      })
      .then((r) => r.data),
  /** 恢复默认：清空该列表的显示配置；自定义列定义保留，需单独删除。 */
  reset: (scope: string) =>
    api.delete<ListScopeConfig>(`/list-columns/${scope}`).then((r) => r.data),
  /** 可新增为自定义列的表单自定义字段（按作用域标注）。 */
  customFields: () =>
    api.get<ListCustomFieldOption[]>("/list-columns/custom-fields").then((r) => r.data),
  /** 新增一列；label 省略则沿用字段标签。 */
  addCustom: (scope: string, fieldKey: string, label?: string) =>
    api
      .post<ListScopeConfig>(`/list-columns/${scope}/custom`, {
        field_key: fieldKey,
        label: label?.trim() || null,
      })
      .then((r) => r.data),
  /** 删除自定义列定义及其显示配置。 */
  removeCustom: (scope: string, columnKey: string) =>
    api
      .delete<ListScopeConfig>(
        `/list-columns/${scope}/custom/${encodeURIComponent(columnKey)}`,
      )
      .then((r) => r.data),
};
