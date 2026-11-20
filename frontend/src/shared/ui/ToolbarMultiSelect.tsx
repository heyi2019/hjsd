import type { SelectProps } from "antd";
import { Select } from "./Select";
import { toolbarSelectionWidth } from "./toolbarSelectionWidth";

export function ToolbarMultiSelect({ selectedLabels, ...props }: SelectProps & { selectedLabels: string[] }) {
  return <Select {...props} mode="multiple" className="ui-filter-multi" maxTagCount="responsive" style={{ width: toolbarSelectionWidth(selectedLabels) }} />;
}
