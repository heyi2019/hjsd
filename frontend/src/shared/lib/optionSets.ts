/** T20：选项词典的前端缓存与读取工具。
 *
 * 选项词典（D 类筛选器 / 业务字典）被库存、资金等页面的筛选器广泛使用，
 * 一次性拉全量后在内存缓存，组件按 code 取用，避免每个筛选器各自请求。
 */
import { useEffect, useState } from "react";
import { optionSetsApi, type OptionItem } from "../api/catalog";

export type OptionSetMap = Record<string, OptionItem[]>;

let cache: OptionSetMap | null = null;
let inflight: Promise<OptionSetMap> | null = null;

/** 加载全部选项词典并缓存；并发请求复用同一 Promise。 */
export function loadOptionSets(): Promise<OptionSetMap> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = optionSetsApi
    .list()
    .then((res) => {
      const map: OptionSetMap = {};
      for (const set of res.items) {
        map[set.code] = set.options ?? [];
      }
      cache = map;
      inflight = null;
      return map;
    })
    .catch((err) => {
      inflight = null;
      throw err;
    });
  return inflight;
}

/** 写入后清缓存，下次读取重新拉取。 */
export function clearOptionSetsCache(): void {
  cache = null;
  inflight = null;
}

/** 组件用：返回全量 code→options 映射（加载中为 null）。 */
export function useOptionSets(): OptionSetMap | null {
  const [map, setMap] = useState<OptionSetMap | null>(cache);
  useEffect(() => {
    let active = true;
    loadOptionSets()
      .then((m) => {
        if (active) setMap(m);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return map;
}

/** 组件用：按 code 取单个选项列表（加载中为 null）。 */
export function useOptionSet(code: string): OptionItem[] | null {
  const map = useOptionSets();
  if (map === null) return null;
  return map[code] ?? null;
}
