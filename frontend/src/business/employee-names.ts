export function indexEmployeeNames(employees: ReadonlyArray<{ id: number; display_name: string }>): Map<number, string> {
  const names = new Map<number, string>();
  for (const employee of employees) {
    const id = employee.id;
    if (!Number.isNaN(id) && !names.has(id)) names.set(id, employee.display_name);
  }
  return names;
}
