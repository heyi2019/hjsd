import { useRef } from "react";

type Draft = { session: number; key: string; startedAt: number };

/** 每个操作草稿保留同一请求键；关闭或切换草稿后生成新键。 */
export function useIdempotencyDraft() {
  const draft = useRef<Draft | null>(null);
  const get = (session = 0): Draft => {
    if (!draft.current || draft.current.session !== session) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const key = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      draft.current = { session, key, startedAt: Date.now() };
    }
    return draft.current;
  };
  const reset = () => { draft.current = null; };
  return { get, reset };
}
