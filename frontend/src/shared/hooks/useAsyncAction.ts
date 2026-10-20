/** 写操作统一入口：串行化 + loading + 错误归一化。
 *
 * 背景：此前各页面自行 try/catch，普遍漏掉三件事——进行中无 loading（用户以为卡死）、
 * 无重复提交保护（连点即重复建单/重复记账）、错误只落页面顶部 ErrorBanner（Modal 打开时被遮罩挡住）。
 * 本 hook 一次收敛这三点：
 *  - `pending`：直接绑到按钮 loading / Modal confirmLoading；
 *  - 防重：`pending` 期间再次 `run` 直接丢弃，不发起第二次请求；
 *  - `error`：归一化后的错误，调用方放进**当前可见的容器**（Modal 内就用 Modal 内的 Alert）。
 */
import { useCallback, useRef, useState } from "react";
import { normalizeError, type NormalizedError } from "../api/client";

export function useAsyncAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<NormalizedError | null>(null);
  // 用 ref 而非 state 做防重闸门：state 更新是异步的，同一帧内连点读到的仍是旧值。
  const busy = useRef(false);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(normalizeError(err));
      return undefined;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { pending, error, run, clearError };
}
