/** 经营中心各报表共用的取数壳、激活态上下文、统计周期类型与说明块。
 * 从 ReportsPage.tsx 拆出：报表本身分文件，壳留在这里避免每个报表重复 try/catch。 */

import { Typography } from "antd";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { normalizeError } from "../../shared/api/client";

/** 报表视图共用的统计周期筛选：提升到父级，使各带区间筛选的报表在 Tab 切换（非挂载）后仍保留筛选条件。 */
export type ReportRange = { params: { from?: string; to?: string }; picker: ReactNode };

/** 经营中心是否处于激活态：透传给 useReport，使 keep-alive 隐藏期间写入的数据在切回时自动重拉。 */
export const ReportsActiveContext = createContext(true);

export function useReportPagination(filterKey: string) {
  const [paging, setPaging] = useState({ filterKey, page: 1, pageSize: 10 });
  const page = paging.filterKey === filterKey ? paging.page : 1;
  useEffect(() => {
    setPaging((current) => current.filterKey === filterKey ? current : { ...current, filterKey, page: 1 });
  }, [filterKey]);
  const onPageChange = useCallback((nextPage: number, pageSize: number) => {
    setPaging((current) => ({ filterKey, page: pageSize === current.pageSize ? nextPage : 1, pageSize }));
  }, [filterKey]);
  return { page, pageSize: paging.pageSize, onPageChange };
}

/** 所有报表共用的取数/错误态壳：避免每个报表各写一遍 try/catch。 */
export function useReport<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const pageActive = useContext(ReportsActiveContext);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const requestRef = useRef(0);

  const reload = useCallback(() => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    setData(null);
    load()
      .then((value) => { if (request === requestRef.current) setData(value); })
      .catch((err) => { if (request === requestRef.current) setError(normalizeError(err)); })
      .finally(() => { if (request === requestRef.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (pageActive) reload();
    else {
      setData(null);
      setError(null);
      setLoading(false);
    }
    return () => { requestRef.current += 1; };
  }, [pageActive, reload]);

  return {
    data: pageActive ? data : null,
    loading: pageActive && (loading || (data === null && !error)),
    error: pageActive ? error : null,
    reload,
  };
}

/** 区间选择已提升到父级（reportRange），各报表通过 range 属性复用父级统计周期。 */

export function Note(props: { children: string }) {
  return (
    <Typography.Paragraph type="secondary" className="muted">
      {props.children}
    </Typography.Paragraph>
  );
}
