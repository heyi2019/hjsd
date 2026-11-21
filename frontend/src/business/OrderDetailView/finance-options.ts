type FinanceOption = { value: number; label: string; disabled: boolean };

export function buildFinanceSelectOptions(
  employees: ReadonlyArray<{ id: number; display_name: string; is_active: boolean }>,
  pools: ReadonlyArray<{ id: number; name: string; status: string }>,
) {
  const employeeOptions = employees.map((employee) => ({
    value: employee.id, label: employee.display_name, disabled: !employee.is_active,
  }));
  const active: FinanceOption[] = [];
  const inactive = new Map<number, Array<{ before: number; option: FinanceOption }>>();
  for (const pool of pools) {
    const enabled = pool.status === "ACTIVE";
    const option = { value: pool.id, label: pool.name, disabled: !enabled };
    if (enabled) active.push(option);
    else if (!Number.isNaN(pool.id)) {
      const entries = inactive.get(pool.id) ?? [];
      entries.push({ before: active.length, option });
      inactive.set(pool.id, entries);
    }
  }
  const cached = new Map<number, FinanceOption[]>();
  const poolsFor = (id: number): FinanceOption[] => {
    const entries = inactive.get(id);
    if (!entries) return active;
    const existing = cached.get(id);
    if (existing) return existing;
    const options: FinanceOption[] = [];
    let start = 0;
    for (const entry of entries) {
      options.push(...active.slice(start, entry.before), entry.option);
      start = entry.before;
    }
    options.push(...active.slice(start));
    cached.set(id, options);
    return options;
  };
  return { employees: employeeOptions, poolsFor };
}
