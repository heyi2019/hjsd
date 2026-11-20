/** 合并本次自定义字段，清空的值不提交，其他操作留下的历史字段保留。 */
export function mergeFormExtra(
  current: unknown,
  previous?: Record<string, unknown> | null,
): Record<string, unknown> {
  const merged = { ...(previous ?? {}) };
  if (!current || typeof current !== "object" || Array.isArray(current)) return merged;
  for (const [key, value] of Object.entries(current)) {
    if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** 新操作不提交空字段；编辑时应使用 mergeFormExtra 保留历史并表达清空。 */
export function formExtraOrUndefined(current: unknown): Record<string, unknown> | undefined {
  const merged = mergeFormExtra(current);
  return Object.keys(merged).length ? merged : undefined;
}
