/**
 * Browser-scoped state reset with no application-module imports.
 * Keep this module dependency-free so Vitest file-local API mocks are not
 * preloaded by the global test setup.
 */
export function resetTestBrowserState(): void {
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--glass-alpha");
}
