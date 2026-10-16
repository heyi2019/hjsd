import { Input } from "antd";
import type { InputProps } from "antd";
import "./MoneyInput.css";

/** 通用金额输入框：数字输入、标准宽度和“元”后缀。 */
export function MoneyInput(props: InputProps) {
  return (
    <Input
      {...props}
      className={["money-input", props.className].filter(Boolean).join(" ")}
      inputMode={props.inputMode ?? "decimal"}
      suffix={props.suffix ?? "元"}
    />
  );
}
