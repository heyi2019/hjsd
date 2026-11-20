/** T20：选项词典的前端缓存与读取工具。
 *
 * 选项词典（D 类筛选器 / 业务字典）被库存、资金等页面的筛选器广泛使用，
 * 一次性拉全量后在内存缓存，组件按 code 取用，避免每个筛选器各自请求。
 */
import { useEffect, useState } from "react";
import { optionSetsApi } from "../api/options.api";
import type { OptionItem } from "../api/types/common";
import { subscribeReferenceDataChanged } from "../state/referenceDataEvents";

type OptionSetMap = Record<string, OptionItem[]>;

let cache: OptionSetMap | null = null;
let inflight: Promise<OptionSetMap> | null = null;
let generation = 0;
const listeners = new Set<() => void>();

/** 加载全部选项词典并缓存；并发请求复用同一 Promise。 */
export function loadOptionSets(): Promise<OptionSetMap> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  const requestGeneration = generation;
  const request = Promise.resolve(optionSetsApi.list())
    .then((res) => {
      if (requestGeneration !== generation) return loadOptionSets();
      const map: OptionSetMap = {};
      // 防御：接口返回空/未打桩（如单测未 mock）时按空词典处理，避免整页白屏。
      for (const set of (res as { items?: Array<{ code: string; options?: OptionItem[] }> } | undefined)?.items ?? []) {
        map[set.code] = set.options ?? [];
      }
      cache = map;
      return map;
    })
    .catch((err) => {
      if (requestGeneration !== generation) return loadOptionSets();
      throw err;
    })
    .finally(() => {
      if (inflight === request) inflight = null;
    });
  inflight = request;
  return request;
}

/** 写入后清缓存，并更新已挂载页面的字典。 */
export function clearOptionSetsCache(): void {
  generation += 1;
  cache = null;
  inflight = null;
  for (const listener of listeners) listener();
}

subscribeReferenceDataChanged("optionSets", clearOptionSetsCache);

/** 组件用：返回全量 code→options 映射（加载中为 null）。 */
function useOptionSets(): OptionSetMap | null {
  const [map, setMap] = useState<OptionSetMap | null>(cache);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const reload = () => {
      const current = ++sequence;
      void loadOptionSets()
        .then((m) => {
          if (active && current === sequence) setMap(m);
        })
        .catch(() => undefined);
    };
    listeners.add(reload);
    reload();
    return () => {
      active = false;
      listeners.delete(reload);
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

/**
 * 同步查询：从已缓存的词典里取某个值的展示文案。
 * 未加载完成或未命中返回 null，调用方回落原硬编码映射（保证零行为变化）。
 * 用于表格 render 这类非 hook 上下文（`labels.ts` 的展示映射、StatusTag 等）。
 */
function optionLabelSync(code: string, value: string | null | undefined): string | null {
  if (!value || !cache) return null;
  const found = (cache[code] ?? []).find((item) => item.value === value);
  return found?.label ?? null;
}

/**
 * 组件用：按 code + value 取展示文案，未命中回落 fallback，再回落原值。
 * 词典加载完成后会触发重渲染，因此设置页改 label 后表格展示同步变化。
 */

/**
 * 展示映射的统一入口（T25）：优先读选项词典，回落传入的硬编码映射，再回落原值。
 * 让 `labels.ts` 的各 `*_LABEL` 与 StatusTag 全局映射具备配置感知能力。
 */
export function configurableLabel(
  code: string,
  value: string | null | undefined,
  fallbackLabels?: Record<string, string>,
): string {
  if (!value) return "-";
  // AUDIT_ACTION 是后端只读字典，前端 fallback 是产品固定口径；已知动作不能被旧库中的
  // 历史文案覆盖，否则本地 dev 数据未重播种时会继续展示旧名称。
  if (code === "AUDIT_ACTION" && fallbackLabels?.[value]) return fallbackLabels[value];
  return optionLabelSync(code, value) ?? fallbackLabels?.[value] ?? value;
}
