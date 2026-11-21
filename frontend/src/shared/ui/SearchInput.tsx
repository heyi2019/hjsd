import { SearchOutlined } from "@ant-design/icons";
import { Input } from "antd";
import type { ComponentProps } from "react";

type SearchInputProps = ComponentProps<typeof Input.Search> & {
  "aria-label": string;
  searchButtonLabel?: string;
};

/** 工具栏搜索框：统一搜索按钮名称与图标，搜索时机由调用方决定。 */
export function SearchInput({ searchButtonLabel, enterButton, allowClear = true, ...props }: SearchInputProps) {
  return <Input.Search {...props} allowClear={allowClear} enterButton={enterButton ?? <span aria-label={searchButtonLabel ?? props["aria-label"]}><SearchOutlined /></span>} />;
}
