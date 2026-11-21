import type { SelectProps } from "antd";
import { Select } from "./Select";
import { toolbarSelectionWidth } from "./toolbarSelectionWidth";

export function ToolbarMultiSelect({ selectedLabels, className, style, ...props }: SelectProps & { selectedLabels: string[] }) {
  return <Select {...props} mode="multiple" className={["ui-filter-multi", className].filter(Boolean).join(" ")} maxTagCount="responsive" style={{ ...style, width: toolbarSelectionWidth(selectedLabels) }} />;
}
