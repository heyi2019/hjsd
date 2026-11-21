import { Typography } from "antd";
import { useId } from "react";
import { MoneyInput } from "../../shared/ui";
import { isValidEditedMoney } from "./editing/amount-validation";

export function OrderDetailMoneyInput({ label, value, onChange, className }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const errorId = useId();
  const invalid = !isValidEditedMoney(value);
  return <div>
    <MoneyInput className={className} aria-label={label} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined}
      value={value} status={invalid ? "error" : undefined} onChange={(event) => {
        const next = event.target.value;
        if (/^\d*(\.\d{0,2})?$/.test(next)) onChange(next);
      }} />
    {invalid && <Typography.Text id={errorId} type="danger">请输入金额</Typography.Text>}
  </div>;
}
