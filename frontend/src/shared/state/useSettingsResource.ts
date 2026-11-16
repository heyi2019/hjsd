import { useCallback, useEffect, useState } from "react";
import { normalizeError, type NormalizedError } from "../api/client";

interface SettingsResourceState<T> {
  data: T | null;
  loading: boolean;
  error: NormalizedError | null;
  reload: () => Promise<void>;
}

interface SettingsResourceOptions {
  onError?: (error: NormalizedError) => void;
}

/**
 * 设置面板的只读资源加载器。
 * 面板只负责提供 load 函数和渲染结果，加载、错误与重试状态在这里统一维护。
 */
export function useSettingsResource<T>(
  load: () => Promise<T>,
  options: SettingsResourceOptions = {},
): SettingsResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<NormalizedError | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await load();
      setData(next);
      setError(null);
    } catch (cause) {
      const normalized = normalizeError(cause);
      setError(normalized);
      options.onError?.(normalized);
    } finally {
      setLoading(false);
    }
  }, [load, options.onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload };
}
