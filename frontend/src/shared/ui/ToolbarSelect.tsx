import type { SelectProps } from "antd";
import { Select } from "./Select";

export function ToolbarSelect({ options, placeholder, className, style, ...props }: SelectProps) {
  const labels = [placeholder, ...(options ?? []).map((option) => option.label)]
    .filter((label): label is string => typeof label === "string");
  const width = Math.min(200, Math.max(96, ...labels.map((label) =>
    40 + Array.from(label).reduce((sum, char) => sum + (char.codePointAt(0)! > 255 ? 16 : 8), 0),
  )));
  return <Select {...props} options={options} placeholder={placeholder} className={["ui-toolbar-select", className].filter(Boolean).join(" ")} style={{ ...style, width }} />;
}
