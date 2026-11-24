import { normalizeError } from "../shared/api/client";
import { ErrorBanner } from "../shared/ui";

/** 人员目录与资金数据独立加载；失败时在当前表单内提供重试。 */
export function EmployeeDirectoryError({ error, reload }: { error: unknown; reload: () => Promise<unknown> }) {
  if (!error) return null;
  const detail = normalizeError(error);
  return <ErrorBanner error={{ ...detail, message: `员工目录加载失败：${detail.message}` }}
    onRetry={() => { void reload().catch(() => undefined); }} />;
}
