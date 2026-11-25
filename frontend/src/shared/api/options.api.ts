import { api } from "./client";
import type { CustomDictionary, CustomDictionaryCatalog, OptionSet, OptionSetList } from "./types/common";
import { notifyReferenceDataChanged } from "../state/referenceDataEvents";

function optionSetsChanged<T>(value: T): T {
  notifyReferenceDataChanged("optionSets");
  return value;
}

export const optionSetsApi = {
  list: (params?: { group?: string; editable?: boolean }) =>
    api.get<OptionSetList>("/option-sets", { params }).then((r) => r.data),
  get: (code: string) =>
    api.get<OptionSet>(`/option-sets/${code}`).then((r) => r.data),
  listCustom: () => api.get<CustomDictionaryCatalog>("/custom-dictionaries").then((r) => r.data),
  createCustom: (label: string, fieldId: number) =>
    api.post<CustomDictionary>("/custom-dictionaries", { label, field_id: fieldId }).then((r) => optionSetsChanged(r.data)),
  deleteCustom: (fieldId: number) =>
    api.delete(`/custom-dictionaries/${fieldId}`).then((r) => optionSetsChanged(r.data)),
  addItem: (code: string, label: string) =>
    api.post<OptionSet>(`/option-sets/${code}/items`, { label }).then((r) => optionSetsChanged(r.data)),
  update: (code: string, payload: Partial<OptionSet>) =>
    api.put<OptionSet>(`/option-sets/${code}`, payload).then((r) => optionSetsChanged(r.data)),
};
