/** 列表列显示配置（前端读取侧）：
 *  从后端拿「哪些列显示 + 什么顺序 + 列宽/固定态」，按配置过滤/排序/覆盖任意 ColumnsType。
 *
 *  设计要点：
 *  - 配置是**服务端单一事实源**（设置页可配、多人共享、有审计），前端不写本地副本；
 *  - 拉取失败或无配置时**全部显示且保持代码顺序**——宁可多显示，不可白屏；
 *  - 未在配置里出现的列（后端新增、前端先上线）视为可见并排在末尾，
 *    避免「新列因为没人配置而永远看不见」；
 *  - 设置页保存后通过订阅即时刷新已挂载的列表，不需要重新进入页面。
 */
import { useEffect, useState } from "react";
import { listColumnsApi, type ListScopeConfig } from "../api/catalog";

type Listener = () => void;

const scopeCache = new Map<string, ListScopeConfig>();
const listeners = new Set<Listener>();
let inflight: Promise<void> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function fetchAll(): Promise<void> {
  if (inflight) return inflight;
  // 用 Promise.resolve 包一层：接口缺失（测试里整体 mock 掉 catalog）或同步抛错时
  // 也只会走到 catch，不会把异常抛进渲染流程把列表打白。
  inflight = Promise.resolve()
    .then(() => listColumnsApi?.all?.())
    .then((scopes) => {
      scopeCache.clear();
      for (const scope of scopes ?? []) scopeCache.set(scope.code, scope);
    })
    .catch(() => {
      // 接口不可用时保留上次缓存（若有），列表按原样渲染
    })
    .finally(() => {
      inflight = null;
      emit();
    });
  return inflight;
}

/** 设置页保存后调用：让所有已挂载列表按新配置重排，无需刷新页面。 */
export function refreshListColumns(): void {
  void fetchAll();
}

/** 取列的稳定标识：优先 key，其次字符串 dataIndex，其次路径式 dataIndex。 */
export function columnKey(column: { key?: unknown; dataIndex?: unknown }): string {
  if (column.key !== undefined && column.key !== null && column.key !== "") return String(column.key);
  const index = column.dataIndex;
  if (typeof index === "string") return index;
  if (Array.isArray(index)) return index.join(".");
  return "";
}

/** 移动端卡片字段按列表配置排列；配置未提供时保持页面定义顺序。 */
export function orderMobileFields<T extends { key: string }>(fields: T[], configuredKeys?: string[]): T[] {
  if (!configuredKeys?.length) return fields;
  const order = new Map(configuredKeys.map((key, index) => [key, index]));
  return fields
    .filter((field) => order.has(field.key))
    .slice()
    .sort((a, b) => (order.get(a.key) as number) - (order.get(b.key) as number));
}

export interface ListViewColumns {
  /** 配置是否已加载（未加载时按原样渲染，避免闪烁） */
  ready: boolean;
  /** 该列当前是否显示（未知列视为显示） */
  isVisible: (key: string) => boolean;
  /** 按配置过滤 + 排序；无配置时原样返回 */
  arrange: <T extends { key?: unknown; dataIndex?: unknown }>(columns: T[]) => T[];
}

export function useListViewColumns(scope: string): ListViewColumns {
  const [config, setConfig] = useState<ListScopeConfig | undefined>(() => scopeCache.get(scope));

  useEffect(() => {
    const sync = () => setConfig(scopeCache.get(scope));
    listeners.add(sync);
    sync();
    if (!scopeCache.has(scope)) void fetchAll();
    return () => {
      listeners.delete(sync);
    };
  }, [scope]);

  if (!config) {
    return {
      ready: false,
      isVisible: () => true,
      arrange: (columns) => columns,
    };
  }

  const visible = new Map(config.columns.map((column) => [column.key, column.is_visible]));

  return {
    ready: true,
    isVisible: (key) => visible.get(key) ?? true,
    arrange: (columns) => applyColumnConfig(columns, config),
  };
}

/** 自定义列取值：优先 form_extra，其次 extra_values，最后回落行对象自身键。
 *
 *  各列表后端 Out 的扩展字段键名不统一（LEDGER/INVENTORY/CUSTOMER 是 extra_values，
 *  INSTALLMENT/REBATE/CASHFLOW 是 form_extra），故两处都查；恒空注入的列表会自然显示 "-"。
 */
export function readCustomValue(row: unknown, sourceKey: string): unknown {
  if (!row || typeof row !== "object") return undefined;
  const record = row as Record<string, unknown>;
  for (const containerKey of ["form_extra", "extra_values"] as const) {
    const container = record[containerKey];
    if (container && typeof container === "object" && !Array.isArray(container)) {
      const value = (container as Record<string, unknown>)[sourceKey];
      if (value !== undefined) return value;
    }
  }
  return record[sourceKey];
}

/** 自定义列单元格格式化：选项码翻中文、多选顿号连接、布尔转是/否、空值显示 "-"。 */
export function formatCustomValue(
  value: unknown,
  valueLabels?: Record<string, string> | null,
): string {
  if (value === null || value === undefined || value === "") return "-";
  if (Array.isArray(value)) {
    if (!value.length) return "-";
    return value.map((item) => valueLabels?.[String(item)] ?? String(item)).join("、");
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  return valueLabels?.[text] ?? text;
}

/** 由配置生成自定义列定义：无 dataIndex，用 render 从行扩展字段取值。
 *
 *  生成的列 key 与后端 column_key 一致，因此后续过滤/排序/列宽/固定覆盖全部照常生效；
 *  各列表页无需改动一行代码，只要调用了 arrange() 就会自动带上自定义列。
 */
function buildCustomColumns<T extends { key?: unknown; dataIndex?: unknown }>(
  config: ListScopeConfig,
): T[] {
  return config.columns
    .filter((column) => column.custom && column.source_key)
    .map(
      (column) =>
        ({
          key: column.key,
          title: column.label,
          render: (_value: unknown, row: unknown) =>
            formatCustomValue(
              readCustomValue(row, column.source_key as string),
              column.value_labels,
            ),
        }) as unknown as T,
    );
}

/** 纯函数：按配置过滤 + 排序 + 覆盖列宽/固定态（便于单测；hook 只是数据来源包装）。
 *
 *  列宽与固定态只在配置里**有值**时覆盖：`null` 表示不覆盖，仍用列定义自身的默认值
 *  —— 这样代码里调整默认列宽不会被历史配置锁死，也不会为未配置的列多造对象。
 *  配置里 `custom` 的列会自动生成列定义注入（见 buildCustomColumns）。
 */
export function applyColumnConfig<T extends { key?: unknown; dataIndex?: unknown }>(
  columns: T[],
  config?: ListScopeConfig,
): T[] {
  if (!config) return columns;
  const order = new Map<string, number>();
  const visible = new Map<string, boolean>();
  const width = new Map<string, number>();
  const fixed = new Map<string, "left" | "right">();
  config.columns.forEach((column, index) => {
    order.set(column.key, column.sort_order ?? index);
    visible.set(column.key, column.is_visible);
    if (column.width != null) width.set(column.key, column.width);
    if (column.fixed) fixed.set(column.key, column.fixed);
  });
  const existing = new Set(columns.map(columnKey));
  const injected = buildCustomColumns<T>(config).filter(
    (column) => !existing.has(columnKey(column)),
  );
  const source = injected.length ? [...columns, ...injected] : columns;
  const decorated = source
    .map((column, index) => {
      const key = columnKey(column);
      const widthOverride = width.get(key);
      const fixedOverride = fixed.get(key);
      const merged =
        widthOverride == null && fixedOverride == null
          ? column
          : ({
              ...column,
              ...(widthOverride != null ? { width: widthOverride } : {}),
              ...(fixedOverride ? { fixed: fixedOverride } : {}),
            } as unknown as T);
      return { column: merged, index, key };
    })
    .filter((item) => visible.get(item.key) ?? true);
  decorated.sort((a, b) => {
    const orderA = order.get(a.key) ?? Number.MAX_SAFE_INTEGER;
    const orderB = order.get(b.key) ?? Number.MAX_SAFE_INTEGER;
    return orderA === orderB ? a.index - b.index : orderA - orderB;
  });
  return decorated.map((item) => item.column);
}
