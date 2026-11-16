import { clearOptionSetsCache } from "@/shared/lib/optionSets";
import { resetTestBrowserState } from "./browser-state";

/** 清理浏览器状态和共享选项缓存，避免跨用例污染。 */
export function resetTestFixtureState(): void {
  resetTestBrowserState();
  clearOptionSetsCache();
}

export { resetTestBrowserState } from "./browser-state";
export { AllProviders, renderApp } from "./render";
