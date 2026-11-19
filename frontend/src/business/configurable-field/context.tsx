/** 字段配置上下文与按作用域拉取配置；拆分自 ConfigurableField.tsx。 */
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { orderFormFieldsApi } from "../../shared/api/orders.api";
import type { OrderFormField } from "../../shared/api/types/forms";

export type FieldConfigMap = Record<string, OrderFormField>;

export function fieldConfigFor(config: FieldConfigMap, key: string): OrderFormField | undefined {
  return config[key];
}

export function useOrderFormConfig(orderType: string | undefined): {
  config: FieldConfigMap;
  loading: boolean;
} {
  const [config, setConfig] = useState<FieldConfigMap>({});
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!orderType) {
      setConfig({});
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    Promise.resolve(orderFormFieldsApi.list(orderType, true))
      .then((rows) => {
        if (cancelled) return;
        const map: FieldConfigMap = {};
        for (const row of rows ?? []) map[row.field_key] = row;
        setConfig(map);
      })
      .catch(() => {
        if (!cancelled) setConfig({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderType]);
  return { config, loading };
}

/** 按业务类型拉取板块标题覆盖映射（section_key -> 显示标题）。
 *  仅在 orderType 有效时请求；无配置或请求失败时降级为空映射，各板块保持原硬编码标题。 */
export function useOrderFormSectionLabels(orderType: string | undefined): {
  labels: Record<string, string>;
  loading: boolean;
} {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!orderType) {
      setLabels({});
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    Promise.resolve(orderFormFieldsApi.listSectionLabels(orderType))
      .then((rows) => {
        if (cancelled) return;
        setLabels(rows ?? {});
      })
      .catch(() => {
        if (!cancelled) setLabels({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderType]);
  return { labels, loading };
}

/** 配置上下文：CreateBusinessModal 注入当前业务类型的字段配置，各 Section 默认从此读取。 */
export const FieldConfigContext = createContext<FieldConfigMap>({});

export function useFieldConfig(): FieldConfigMap {
  return useContext(FieldConfigContext);
}

/** 板块标题配置上下文：CreateBusinessModal / FieldConfigScope 把当前业务类型的板块标题映射注入此处，
 * 各 Section 的硬编码标题改用 ``sectionLabel(key, fallback)`` 读取，实现「设置里改板块名 → 建单同步显示」。 */
export const SectionLabelsContext = createContext<Record<string, string>>({});

export function useSectionLabels(): Record<string, string> {
  return useContext(SectionLabelsContext);
}

/** 读取板块显示标题：优先用配置覆盖值，无配置时回退硬编码 fallback（与 fieldLabel 同机制）。 */
export function sectionLabel(key: string, fallback: string): string {
  const labels = useSectionLabels();
  return labels[key] ?? fallback;
}

/** 按「表单作用域」按需拉取配置并注入上下文。
 *  仅在 active 为 true 时请求，避免多弹窗面板挂载时一次性拉取全部作用域配置；
 *  无配置或请求失败时降级为空配置，各字段保持原硬编码标签/必填态。 */
export function FieldConfigScope(props: {
  scope: string;
  active: boolean;
  children: ReactNode;
}): ReactElement {
  const { config } = useOrderFormConfig(props.active ? props.scope : undefined);
  const { labels } = useOrderFormSectionLabels(props.active ? props.scope : undefined);
  return (
    <FieldConfigContext.Provider value={config}>
      <SectionLabelsContext.Provider value={labels}>{props.children}</SectionLabelsContext.Provider>
    </FieldConfigContext.Provider>
  );
}
