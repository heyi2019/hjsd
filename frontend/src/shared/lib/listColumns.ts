/** 列表列显示配置（前端读取侧）：
 *  从后端拿「哪些列显示 + 什么顺序 + 固定态」，按配置过滤/排序/覆盖任意 ColumnsType。
 *
 *  设计要点：
 *  - 配置是**服务端单一事实源**（设置页可配、多人共享、有审计），前端不写本地副本；
 *  - 拉取失败或无配置时**全部显示且保持代码顺序**——宁可多显示，不可白屏；
 *  - 未在配置里出现的列（后端新增、前端先上线）视为可见并排在末尾，
 *    避免「新列因为没人配置而永远看不见」；
 *  - 设置页保存后通过订阅即时刷新已挂载的列表，不需要重新进入页面。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { listColumnsApi } from "../api/orders.api";
import type { ListScopeConfig } from "../api/types/forms";

type Listener = () => void;

const scopeCache = new Map<string, ListScopeConfig>();
const scopeRevisions = new Map<string, number>();
const listeners = new Set<Listener>();
let inflight: Promise<void> | null = null;
let revision = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function fetchAll(): Promise<void> {
  if (inflight) return inflight;
  const startedAt = revision;
  // 用 Promise.resolve 包一层：接口缺失（测试里整体 mock 掉 catalog）或同步抛错时
  // 也只会走到 catch，不会把异常抛进渲染流程把列表打白。
  inflight = Promise.resolve()
    .then(() => listColumnsApi?.all?.())
    .then((scopes) => {
      const received = new Set((scopes ?? []).map((scope) => scope.code));
      for (const code of scopeCache.keys()) {
        if (!received.has(code) && (scopeRevisions.get(code) ?? 0) <= startedAt) {
          scopeCache.delete(code);
          scopeRevisions.delete(code);
        }
      }
      for (const scope of scopes ?? []) {
        if ((scopeRevisions.get(scope.code) ?? 0) <= startedAt) scopeCache.set(scope.code, scope);
      }
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

/** 保存接口返回完整配置，可直接同步页面；较早发出的全量读取不得覆盖它。 */
export function updateListColumnScope(scope: ListScopeConfig): void {
  scopeRevisions.set(scope.code, ++revision);
  scopeCache.set(scope.code, scope);
  emit();
}

/** 取列的稳定标识：优先 key，其次字符串 dataIndex，其次路径式 dataIndex。 */
export function columnKey(column: { key?: unknown; dataIndex?: unknown }): string {
  if (column.key !== undefined && column.key !== null && column.key !== "") return String(column.key);
  const index = column.dataIndex;
  if (typeof index === "string") return index;
  if (Array.isArray(index)) return index.join(".");
  return "";
}

/** ≤640px 隐藏列的标记 class。th 靠 column.className、td 靠 onCell，antd 必须双写。 */
export const MOBILE_HIDE_CLASS = "ui-col-mobile-hide";

/** 按列 key 给列打移动端隐藏标记。
 *  必须在 arrange() / applyColumnConfig() 之后调用：列表列配置会过滤 + 排序，
 *  用 nth-child 物理序号隐藏会随配置错位（曾把「状态」列藏掉、把联系方式露出来）。
 *  已有 className / onCell 会被保留并合并，不覆盖列定义自身的行为。 */
export function markMobileHiddenColumns<T extends { key?: unknown; dataIndex?: unknown }>(
  columns: T[],
  hiddenKeys: readonly string[],
): T[] {
  const hidden = new Set(hiddenKeys);
  return columns.map((column) => {
    if (!hidden.has(columnKey(column))) return column;
    const source = column as T & {
      className?: string;
      onCell?: (record: unknown, index?: number) => Record<string, unknown>;
    };
    const baseClassName = source.className ?? "";
    const baseOnCell = source.onCell;
    return {
      ...column,
      className: [baseClassName, MOBILE_HIDE_CLASS].filter(Boolean).join(" "),
      onCell: (record: unknown, index?: number) => {
        const cell: Record<string, unknown> = (baseOnCell ? baseOnCell(record, index) : {}) ?? {};
        const cellClass = typeof cell.className === "string" ? cell.className : "";
        return { ...cell, className: [cellClass, MOBILE_HIDE_CLASS].filter(Boolean).join(" ") };
      },
    } as T;
  });
}

/** 移动端固定优先标识列；用户隐藏该列时退回首个仍可见的列。 */
export function markMobileIdentityColumn<T extends { key?: unknown; dataIndex?: unknown }>(columns: T[], preferredKey: string): T[] {
  const available = columns.filter((column) => !String((column as T & { className?: string }).className ?? "").split(/\s+/).includes(MOBILE_HIDE_CLASS));
  const target = available.find((column) => columnKey(column) === preferredKey) ?? available[0];
  if (!target) return columns;
  const source = target as T & { className?: string; onCell?: (record: unknown, index?: number) => Record<string, unknown> };
  return columns.map((column) => column !== target ? column : {
    ...column,
    className: [source.className, "ui-col-mobile-identity"].filter(Boolean).join(" "),
    onCell: (record: unknown, index?: number) => {
      const cell = source.onCell?.(record, index) ?? {};
      return { ...cell, className: [cell.className, "ui-col-mobile-identity"].filter(Boolean).join(" ") };
    },
  } as T);
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

  // config 引用由 setConfig(scopeCache.get(scope)) 写入：配置未变时同一引用（React 同值 bail out），
  // 设置页保存后 emit() → setConfig 拿到新引用。故以 config 为依赖即可让 arrange/isVisible 在配置
  // 不变时保持引用稳定，配置变更时正确重建——下游 columns useMemo 依赖 arrange 才不会被无谓打断。
  const visible = useMemo(
    () => (config ? new Map(config.columns.map((column) => [column.key, column.is_visible])) : null),
    [config],
  );

  const isVisible = useCallback((key: string) => visible?.get(key) ?? true, [visible]);

  const arrange = useCallback(
    <T extends { key?: unknown; dataIndex?: unknown }>(columns: T[]): T[] =>
      config ? applyColumnConfig(columns, config) : columns,
    [config],
  );

  return {
    ready: Boolean(config),
    isVisible,
    arrange,
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
 *  生成的列 key 与后端 column_key 一致，因此后续过滤/排序/固定覆盖全部照常生效；
 *  各列表页无需改动一行代码，只要调用了 arrange() 就会自动带上自定义列。
 */
function buildCustomColumns<T extends { key?: unknown; dataIndex?: unknown }>(
  config: ListScopeConfig,
): T[] {
  return config.columns
    .filter((column) => column.custom && column.source_key)
    .map((column) => {
      // 从零构造的列对象不继承任何 T 的字段，而 T 可能是嵌套 ColumnsType，
      // 故此处必须经 unknown 中转（as T 会报 TS2352 无足够重叠）。这是泛型边界
      // 的必要断言，与下方 markMobileHiddenColumns / applyColumnConfig 的 spread
      // 后可安全 as T 不同——那两处结果继承 T 字段，双重断言是多余的。
      const custom = {
        key: column.key,
        title: column.label,
        render: (_value: unknown, row: unknown) => {
          const sourceKey = column.source_key as string;
          const value = readCustomValue(row, sourceKey);
          const snapshots = row && typeof row === "object" ? (row as Record<string, unknown>).option_label_snapshot : null;
          const label = snapshots && typeof snapshots === "object" && !Array.isArray(snapshots)
            ? (snapshots as Record<string, unknown>)[sourceKey] : null;
          if (Array.isArray(value) && label && typeof label === "object" && !Array.isArray(label)) {
            const historical = Object.fromEntries(Object.entries(label).filter(([, text]) => typeof text === "string")) as Record<string, string>;
            return formatCustomValue(value, { ...column.value_labels, ...historical });
          }
          return typeof value === "string" && typeof label === "string"
            ? label : formatCustomValue(value, column.value_labels);
        },
      };
      return custom as unknown as T;
    });
}

/** 纯函数：按配置过滤 + 排序 + 覆盖固定态（便于单测；hook 只是数据来源包装）。
 * 配置里 `custom` 的列会自动生成列定义注入（见 buildCustomColumns）。
 */
export function applyColumnConfig<T extends { key?: unknown; dataIndex?: unknown }>(
  columns: T[],
  config?: ListScopeConfig,
): T[] {
  if (!config) return columns;
  const order = new Map<string, number>();
  const visible = new Map<string, boolean>();
  const fixed = new Map<string, "left" | "right">();
  config.columns.forEach((column, index) => {
    order.set(column.key, column.sort_order ?? index);
    visible.set(column.key, column.is_visible);
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
      const fixedOverride = fixed.get(key);
      const merged =
        fixedOverride == null
          ? column
          : ({
              ...column,
              ...(fixedOverride ? { fixed: fixedOverride } : {}),
            } as T);
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
