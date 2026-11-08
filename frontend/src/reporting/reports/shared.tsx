/** 经营中心各报表共用的取数壳、激活态上下文、统计周期类型与说明块。
 * 从 ReportsPage.tsx 拆出：报表本身分文件，壳留在这里避免每个报表重复 try/catch。 */

import { Typography } from "antd";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { normalizeError } from "../../shared/api/client";
import { useReloadOnActive } from "../../shared/state/reloadOnActive";

/** 报表视图共用的统计周期筛选：提升到父级，使各带区间筛选的报表在 Tab 切换（非挂载）后仍保留筛选条件。 */
export type ReportRange = { params: { from?: string; to?: string }; picker: ReactNode };

/** 经营中心是否处于激活态：透传给 useReport，使切回页面时自动重拉。 */
export const ReportsActiveContext = createContext(true);

/** 所有报表共用的取数/错误态壳：避免每个报表各写一遍 try/catch。 */
export function useReport<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const pageActive = useContext(ReportsActiveContext);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    load()
      .then(setData)
      .catch((err) => setError(normalizeError(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);
  // 首次挂载由上一 effect 覆盖，这里只负责「重新激活」的重拉，避免重复请求。
  useReloadOnActive(pageActive, reload, { skipFirstMount: true });

  return { data, loading, error, reload };
}

/** 区间选择已提升到父级（reportRange），各报表通过 range 属性复用父级统计周期。 */

export function Note(props: { children: string }) {
  return (
    <Typography.Paragraph type="secondary" className="muted">
      {props.children}
    </Typography.Paragraph>
  );
}
