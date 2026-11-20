import { useEffect } from "react";
import { subscribeReferenceDataChanged, type ReferenceData } from "../state/referenceDataEvents";

export function useReferenceRefresh(resource: ReferenceData, reload: () => Promise<void>, remoteOnly = false): void {
  useEffect(() => subscribeReferenceDataChanged(resource, (origin) => {
    if (!remoteOnly || origin === "remote") void reload();
  }), [resource, reload, remoteOnly]);
}
