/** 列表列配置面板的状态与交互逻辑（抽取自 ListColumnsPanel，保持行为逐字等价）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listColumnsApi } from "../../shared/api/orders.api";
import type { ListColumnConfig, ListCustomFieldOption, ListScopeConfig } from "../../shared/api/types/forms";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { refreshListColumns } from "../../shared/lib/listColumns";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { appMessage } from "../../shared/ui/appFeedback";

export function useListColumnsController() {
  const [scopes, setScopes] = useState<ListScopeConfig[]>([]);
  const [activeScope, setActiveScope] = useState<string>("");
  const [rows, setRows] = useState<ListColumnConfig[]>([]);
  const [mutationError, setMutationError] = useState<NormalizedError | null>(null);
  const [saving, setSaving] = useState(false);
  // 新增自定义列弹窗状态
  const [addOpen, setAddOpen] = useState(false);
  const [fieldOptions, setFieldOptions] = useState<ListCustomFieldOption[]>([]);
  const [selectedField, setSelectedField] = useState<string | undefined>();
  const [customLabel, setCustomLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  /** 批量操作勾选：所有列（含身份列）均可勾选切换显示，与单行隐藏按钮同口径。 */
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  /** 拖拽排序：记录拖起行的列键，drop 到目标行时重排并整表提交。 */
  const dragKeyRef = useRef<string | null>(null);

  const applyScopes = useCallback((items: ListScopeConfig[], preferred?: string) => {
    setScopes(items);
    const target = preferred ?? items[0]?.code ?? "";
    setActiveScope(target);
    setRows(items.find((item) => item.code === target)?.columns ?? []);
  }, []);

  /** 一次保存成功后统一回填行、scope 缓存，并通知所有已挂载列表重排。 */
  const applySaved = useCallback((saved: ListScopeConfig) => {
    setRows(saved.columns);
    setScopes((items) => items.map((item) => (item.code === saved.code ? saved : item)));
    refreshListColumns();
  }, []);

  const load = useCallback(() => listColumnsApi.all(), []);
  const { data: loadedScopes, loading, error: loadError, reload } = useSettingsResource(load);
  const error = mutationError ?? loadError;

  // 切 scope 由 switchScope 自己 setRows；effect 只在首次加载 / reload 时用服务端
  // 数据重建快照。若把 activeScope 列进 effect 依赖，切换时会用 useSettingsResource
  // 的旧 data 覆盖 applySaved 刚写入的配置（切走再切回即丢改动）。用 ref 读当前
  // scope，既保留 reload 时「停在当前列表」的行为，也不会因 scope 变化重跑 effect。
  const activeScopeRef = useRef(activeScope);
  activeScopeRef.current = activeScope;
  useEffect(() => {
    if (loadedScopes) applyScopes(loadedScopes, activeScopeRef.current || undefined);
  }, [applyScopes, loadedScopes]);

  const reloadPanel = useCallback(async () => {
    setMutationError(null);
    await reload();
  }, [reload]);

  const switchScope = (code: string) => {
    setActiveScope(code);
    setRows(scopes.find((item) => item.code === code)?.columns ?? []);
    setSelectedRowKeys([]);
  };

  /** 提交整表：顺序即数组顺序，sort_order 由后端按位置归一。 */
  const persist = async (next: ListColumnConfig[], successText: string) => {
    const previous = rows;
    setRows(next);
    setSaving(true);
    try {
      const saved = await listColumnsApi.save(
        activeScope,
        next.map((column, index) => ({
          key: column.key,
          is_visible: column.is_visible,
          sort_order: index * 10,
          fixed: column.fixed ?? null,
        })),
      );
      applySaved(saved);
      appMessage.success(successText);
    } catch (err) {
      setRows(previous);
      appMessage.error(normalizeError(err).message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: string, visible: boolean) =>
    persist(
      rows.map((column) => (column.key === key ? { ...column, is_visible: visible } : column)),
      visible ? "已设为显示" : "已隐藏该列",
    );

  const setFixed = (key: string, fixed: string) =>
    persist(
      rows.map((column) =>
        column.key === key
          ? { ...column, fixed: fixed === "none" ? null : (fixed as "left" | "right") }
          : column,
      ),
      fixed === "none" ? "已取消固定" : "已固定该列",
    );

  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    void persist(next, "顺序已更新");
  };

  /** 批量显示：一次整表提交，避免十几列逐列点。 */
  const showAll = () => {
    if (rows.every((column) => column.is_visible)) {
      appMessage.info("当前已是全部显示");
      return;
    }
    void persist(
      rows.map((column) => ({ ...column, is_visible: true })),
      "已显示全部列",
    );
  };

  /** 批量显示/隐藏所选列：一次整表提交；所有列（含身份列）均可批量切换，与单行操作同口径。 */
  const batchSetVisible = (visible: boolean) => {
    const targets = new Set(selectedRowKeys.map(String));
    if (!targets.size) return;
    setSelectedRowKeys([]);
    void persist(
      rows.map((column) => (targets.has(column.key) ? { ...column, is_visible: visible } : column)),
      visible ? "已显示所选列" : "已隐藏所选列",
    );
  };

  /** 恢复默认：清空该列表显示配置，回到注册表顺序与全列可见（自定义列定义保留）。 */
  const resetAll = async () => {
    const saved = await listColumnsApi.reset(activeScope);
    applySaved(saved);
    appMessage.success("已恢复默认列配置");
  };

  /** 打开新增弹窗时才拉候选字段（全部启用中的表单自定义字段）。 */
  const openAdd = async () => {
    setAddOpen(true);
    setSelectedField(undefined);
    setCustomLabel("");
    setFieldOptions([]);
    try {
      setFieldOptions(await listColumnsApi.customFields());
      setMutationError(null);
    } catch (err) {
      setMutationError(normalizeError(err));
    }
  };

  const submitAdd = async () => {
    if (!selectedField) {
      appMessage.info("请先选择一个字段");
      return;
    }
    setSubmitting(true);
    try {
      const saved = await listColumnsApi.addCustom(activeScope, selectedField, customLabel);
      applySaved(saved);
      setAddOpen(false);
      appMessage.success("自定义列已新增");
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  const removeCustom = async (key: string) => {
    setRemovingKey(key);
    try {
      const saved = await listColumnsApi.removeCustom(activeScope, key);
      applySaved(saved);
      appMessage.success("自定义列已删除");
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setRemovingKey(null);
    }
  };

  /** 候选字段按来源分组：表单作用域 + 「数据中已有值」（无字段定义的历史数据键）。 */
  const groupedFieldOptions = useMemo(() => {
    const groups = new Map<string, Array<{ value: string; label: string }>>();
    for (const item of fieldOptions) {
      const group =
        item.data_only
          ? "数据中已有值（按原值展示）"
          : `${item.scope_label}（${item.scope}）`;
      const suffix = item.data_only
        ? `${item.field_key}，${item.source_label ?? ""} ${item.row_count ?? 0} 行`
        : item.field_key;
      const list = groups.get(group) ?? [];
      list.push({ value: item.field_key, label: `${item.label}（${suffix}）` });
      groups.set(group, list);
    }
    return [...groups].map(([label, options]) => ({ label, options }));
  }, [fieldOptions]);
  const selectedOptionLabel = fieldOptions.find((item) => item.field_key === selectedField)?.label;


  return {
    scopes, activeScope, rows, error, saving, addOpen, selectedField, customLabel,
    submitting, removingKey, selectedRowKeys, setSelectedRowKeys, loading, dragKeyRef,
    setAddOpen, setSelectedField, setCustomLabel,
    reloadPanel, switchScope, persist, toggle, setFixed, move, showAll,
    batchSetVisible, resetAll, openAdd, submitAdd, removeCustom,
    groupedFieldOptions, selectedOptionLabel,
  };
}
