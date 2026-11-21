export function toolbarLabelWidth(label: string): number {
  return Array.from(label).reduce((sum, char) => sum + (char.codePointAt(0)! > 255 ? 16 : 8), 0);
}

export function toolbarSelectionWidth(labels: string[]): number {
  const width = labels.reduce((total, label) => total + 36 + toolbarLabelWidth(label), 48);
  return Math.min(240, Math.max(120, width));
}
