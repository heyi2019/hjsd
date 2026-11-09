import { Button, Divider } from "antd";
import type { ReactNode } from "react";
import type { SelectProps } from "antd";
import { Select } from "../shared/ui";
import "./PartyMasterSelect.css";

export type PartyMasterOption = { value: number; label: string };

/** 主数据选择器：优先选择已有档案，也允许从当前下拉直接进入建档。 */
export function PartyMasterSelect(props: {
  options: PartyMasterOption[];
  placeholder: string;
  createLabel: string;
  emptyText: ReactNode;
  onCreate: () => void;
} & Omit<SelectProps, "options" | "placeholder" | "popupRender" | "notFoundContent">) {
  const { options, placeholder, createLabel, emptyText, onCreate, ...selectProps } = props;
  return (
    <Select
      {...selectProps}
      showSearch
      optionFilterProp="label"
      placeholder={placeholder}
      options={options}
      notFoundContent={emptyText}
      popupRender={(menu) => (
        <>
          {menu}
          <Divider className="party-master-select__divider" />
          <Button
            type="link"
            block
            onMouseDown={(event) => event.preventDefault()}
            onClick={onCreate}
          >
            {createLabel}
          </Button>
        </>
      )}
    />
  );
}
