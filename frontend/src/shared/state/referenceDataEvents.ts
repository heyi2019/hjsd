import { clearApiCache } from "../api/client";

export type ReferenceData = "employees" | "teams" | "pools" | "gameTypes" | "optionSets" | "formFields" | "formSections";
type ChangeOrigin = "local" | "remote";

const listeners = new Map<ReferenceData, Set<(origin: ChangeOrigin) => void>>();
const eventKey = "hj.reference-data-changed";
const resources = new Set<ReferenceData>(["employees", "teams", "pools", "gameTypes", "optionSets", "formFields", "formSections"]);

function dispatchReferenceDataChanged(resource: ReferenceData, origin: ChangeOrigin): void {
  for (const listener of listeners.get(resource) ?? []) listener(origin);
}

export function subscribeReferenceDataChanged(resource: ReferenceData, listener: (origin: ChangeOrigin) => void): () => void {
  let subscribers = listeners.get(resource);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(resource, subscribers);
  }
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

export function notifyReferenceDataChanged(resource: ReferenceData): void {
  dispatchReferenceDataChanged(resource, "local");
  try {
    localStorage.setItem(eventKey, JSON.stringify({ resource, id: `${Date.now()}-${Math.random()}` }));
  } catch {
    // 本页联动已完成；存储不可用时不影响已成功的写入。
  }
}

function onStorage(event: StorageEvent): void {
  if (event.key !== eventKey || !event.newValue) return;
  try {
    const { resource } = JSON.parse(event.newValue) as { resource?: ReferenceData };
    if (!resource || !resources.has(resource)) return;
    clearApiCache();
    dispatchReferenceDataChanged(resource, "remote");
  } catch {
    // 忽略其它页面写入的无效消息。
  }
}

window.addEventListener("storage", onStorage);
if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener("storage", onStorage));
