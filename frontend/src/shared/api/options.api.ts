import { api } from "./client";
import type { OptionSet, OptionSetList } from "./types/common";
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
  create: (payload: Partial<OptionSet>) =>
    api.post<OptionSet>("/option-sets", payload).then((r) => optionSetsChanged(r.data)),
  update: (code: string, payload: Partial<OptionSet>) =>
    api.put<OptionSet>(`/option-sets/${code}`, payload).then((r) => optionSetsChanged(r.data)),
  remove: (code: string) => api.delete(`/option-sets/${code}`).then(optionSetsChanged),
};
