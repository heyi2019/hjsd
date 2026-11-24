/** 列表列配置面板的状态与交互逻辑（抽取自 ListColumnsPanel，保持行为逐字等价）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listColumnsApi } from "../../shared/api/orders.api";
import type { ListColumnConfig, ListCustomFieldOption, ListScopeConfig } from "../../shared/api/types/forms";
import { normalizeError, type NormalizedError } from "../../shared/api/client";
import { updateListColumnScope } from "../../shared/lib/listColumns";
import { useSettingsResource } from "../../shared/state/useSettingsResource";
import { appMessage } from "../../shared/ui/appFeedback";

export function useListColumnsController() {
  const [scopes, setScopes] = useState<ListScopeConfig[]>([]);
  const [activeScope, setActiveScope] = useState<string>("");
  const rows = scopes.find((item) => item.code === activeScope)?.columns ?? [];
  const [mutationError, setMutationError] = useState<NormalizedError | null>(null);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  // 新增自定义列弹窗状态
  const [addOpen, setAddOpen] = useState(false);
  const [fieldOptions, setFieldOptions] = useState<ListCustomFieldOption[]>([]);
  const [selectedField, setSelectedField] = useState<string | undefined>();
  const [customLabel, setCustomLabel] = useState("");
  /** 批量操作勾选：所有列（含身份列）均可勾选切换显示，与单行隐藏按钮同口径。 */
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  /** 拖拽排序：记录拖起行的列键，drop 到目标行时重排并整表提交。 */
  const dragKeyRef = useRef<string | null>(null);

  const applyScopes = useCallback((items: ListScopeConfig[], preferred?: string) => {
    // 保留旧 REBATE 导出配置的历史记录；页面表格使用 REBATE_DETAIL。
    const visibleItems = items.filter((item) => item.code !== "REBATE");
    setScopes(visibleItems);
    const target = visibleItems.some((item) => item.code === preferred) ? preferred! : visibleItems[0]?.code ?? "";
    setActiveScope(target);
  }, []);

  const setScopeRows = useCallback((code: string, columns: ListColumnConfig[]) => {
    setScopes((items) => items.map((item) => item.code === code ? { ...item, columns } : item));
  }, []);

  /** 仅更新响应所属的列表，并通知已挂载列表重排。 */
  const applySaved = useCallback((saved: ListScopeConfig) => {
    setScopes((items) => items.map((item) => (item.code === saved.code ? saved : item)));
    updateListColumnScope(saved);
  }, []);

  const load = useCallback(() => listColumnsApi.all(), []);
  const { data: loadedScopes, loading, error: loadError, reload } = useSettingsResource(load);
  const error = mutationError ?? loadError;

  // 只在加载结果变化时重建快照；切换列表不应重新应用旧的服务端数据。
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
    setSelectedRowKeys([]);
  };

  const saveScope = async (
    write: (scope: string) => Promise<ListScopeConfig>,
    successText: string,
    optimisticRows?: ListColumnConfig[],
  ) => {
    if (saveInFlight.current) return false;
    const scope = activeScope;
    const previous = rows;
    saveInFlight.current = true;
    setSaving(true);
    if (optimisticRows) setScopeRows(scope, optimisticRows);
    try {
      const saved = await write(scope);
      applySaved(saved);
      appMessage.success(successText);
      return true;
    } catch (err) {
      if (optimisticRows) setScopeRows(scope, previous);
      throw err;
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  /** 提交整表：顺序即数组顺序，sort_order 由后端按位置归一。 */
  const persist = async (next: ListColumnConfig[], successText: string) => {
    try {
      await saveScope(
        (scope) => listColumnsApi.save(scope, next.map((column, index) => ({
          key: column.key,
          is_visible: column.is_visible,
          sort_order: index * 10,
          fixed: column.fixed ?? null,
        }))),
        successText,
        next,
      );
    } catch (err) {
      appMessage.error(normalizeError(err).message);
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
    await saveScope((scope) => listColumnsApi.reset(scope), "已恢复默认列配置");
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
    try {
      const saved = await saveScope(
        (scope) => listColumnsApi.addCustom(scope, selectedField, customLabel),
        "自定义列已新增",
      );
      if (saved) setAddOpen(false);
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    }
  };

  const removeCustom = async (key: string) => {
    try {
      await saveScope((scope) => listColumnsApi.removeCustom(scope, key), "自定义列已删除");
    } catch (err) {
      appMessage.error(normalizeError(err).message);
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
    selectedRowKeys, setSelectedRowKeys, loading, dragKeyRef,
    setAddOpen, setSelectedField, setCustomLabel,
    reloadPanel, switchScope, persist, toggle, setFixed, move, showAll,
    batchSetVisible, resetAll, openAdd, submitAdd, removeCustom,
    groupedFieldOptions, selectedOptionLabel,
  };
}
