/**
 * 选项词典的前端缓存：建单、售出、记流水都要用（客户来源、中介平台、收支科目…），
 * 每个页面各自拉一次会让首屏多打 3~4 个请求。这里一次性拉全量、进程内缓存。
 */
import { useEffect, useState } from "react";
import { listOptionSets, type OptionItem } from "../api";

let cache: Record<string, OptionItem[]> | null = null;
let inflight: Promise<Record<string, OptionItem[]>> | null = null;

export function loadOptionSets(): Promise<Record<string, OptionItem[]>> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = listOptionSets()
    .then((rows) => {
      const map: Record<string, OptionItem[]> = {};
      for (const row of rows) map[row.code] = row.options ?? [];
      cache = map;
      inflight = null;
      return map;
    })
    .catch((error: unknown) => {
      inflight = null;
      throw error;
    });
  return inflight;
}

export function clearOptionSetsCache(): void {
  cache = null;
  inflight = null;
}

/** 取某个词典；未加载完返回空数组（调用方一律要有兜底选项）。 */
export function useOptionSet(code: string): OptionItem[] {
  const [map, setMap] = useState<Record<string, OptionItem[]> | null>(cache);
  useEffect(() => {
    let alive = true;
    void loadOptionSets()
      .then((next) => {
        if (alive) setMap(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return map?.[code] ?? [];
}
