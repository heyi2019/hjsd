type ReferenceData = "employees" | "pools" | "gameTypes" | "optionSets" | "formFields" | "formSections";

const listeners = new Map<ReferenceData, Set<() => void>>();

export function subscribeReferenceDataChanged(resource: ReferenceData, listener: () => void): () => void {
  let subscribers = listeners.get(resource);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(resource, subscribers);
  }
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

export function notifyReferenceDataChanged(resource: ReferenceData): void {
  for (const listener of listeners.get(resource) ?? []) listener();
}
