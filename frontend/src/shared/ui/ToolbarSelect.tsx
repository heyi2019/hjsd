import type { SelectProps } from "antd";
import { Select } from "./Select";
import { toolbarLabelWidth } from "./toolbarSelectionWidth";

function optionLabels(options: NonNullable<SelectProps["options"]>): string[] {
  return options.flatMap((option) => Array.isArray(option.options)
    ? optionLabels(option.options)
    : typeof option.label === "string" ? [option.label] : []);
}

export function ToolbarSelect({ options, placeholder, className, style, ...props }: SelectProps) {
  const labels = [placeholder, ...optionLabels(options ?? [])]
    .filter((label): label is string => typeof label === "string");
  const width = Math.min(200, Math.max(96, ...labels.map((label) =>
    40 + toolbarLabelWidth(label),
  )));
  return <Select {...props} options={options} placeholder={placeholder} className={["ui-toolbar-select", className].filter(Boolean).join(" ")} style={{ ...style, width }} />;
}
