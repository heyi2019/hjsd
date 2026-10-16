import { Form } from "antd";
import type { FormInstance } from "antd";

export function useRecoveryFormState(form: FormInstance) {
  const customerSource = Form.useWatch("customer_source", form) as string | undefined;
  const intermediaryFee = Form.useWatch("intermediary_fee", form) as number | undefined;
  const intermediaryType = Form.useWatch("intermediary_type", form) as string | undefined;
  const recoveryPrice = Form.useWatch("recovery_price", form) as number | undefined;
  const otherFeeAmount = Form.useWatch("other_fee_amount", form) as number | undefined;

  return {
    customerSource,
    intermediaryFee,
    intermediaryType,
    totalRecoveryCost: (Number(recoveryPrice) || 0) + (Number(intermediaryFee) || 0) + (Number(otherFeeAmount) || 0),
  };
}
