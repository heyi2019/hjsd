import type { FormInstance } from "antd/es/form";
import type { ReactNode } from "react";
import { Input } from "antd";
import type { Pool } from "../shared/api/catalog";
import {
  AdaptiveFormGrid,
  BusinessActionModal,
  BusinessRegistrationForm,
  MoneyInput,
  Select,
} from "../shared/ui";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../orders/ConfigurableField";
import { money } from "../shared/lib/format";

export type InventoryCancellationValues = {
  amount: string;
  pool_id: number;
  reason: string;
  form_extra?: Record<string, unknown>;
};

export function InventoryCancellationDialog<T extends InventoryCancellationValues>(props: {
  open: boolean;
  title: string;
  amount: string;
  pools: Pool[];
  form: FormInstance<T>;
  scope: "INVOID" | "INVREFUND" | "ORDERCANC";
  description: ReactNode;
  okText: string;
  amountLabel?: string;
  accountLabel?: string;
  submitting?: boolean;
  onCancel: () => void;
  onFinish: (values: T) => void | Promise<void>;
}) {
  const maximum = Number(props.amount);
  const amountLabel = props.amountLabel ?? "退回金额";
  const accountLabel = props.accountLabel ?? "收款账户";
  return (
    <BusinessActionModal size="compact" width={720} wrapClassName="inventory-void-modal"
      title={props.title}
      open={props.open}
      okText={props.okText}
      cancelText="返回"
      confirmLoading={props.submitting}
      okButtonProps={{ danger: true }}
      onOk={() => props.form.submit()}
      onCancel={props.onCancel}
    >
      <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope={props.scope} form={props.form} onFinish={props.onFinish}>
        <div className="inventory-cancellation-note">{props.description}</div>
        <FieldConfigScope scope={props.scope} active={props.open}>
          <AdaptiveFormGrid className="inventory-void-fields">
            <CfgItem
              alwaysActive
              name="amount"
              label={amountLabel}
              fixedLabel={amountLabel}
              initialValue={props.amount}
              rules={[
                { required: true, message: `请输入${amountLabel}` },
                { validator: async (_, value) => {
                  const amount = Number(value);
                  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`请输入大于 0 的${amountLabel}`);
                  if (amount > maximum) throw new Error(`${amountLabel}不能超过 ¥${money(props.amount)}`);
                } },
              ]}
            >
              <MoneyInput aria-label={amountLabel} placeholder={`请输入${amountLabel}`} />
            </CfgItem>
            <CfgItem alwaysActive name="pool_id" label={accountLabel} fixedLabel={accountLabel} rules={[{ required: true, message: `请选择${accountLabel}` }]}>
              <Select placeholder={`请选择${accountLabel}`} options={props.pools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} notFoundContent={`暂无可用${accountLabel}`} />
            </CfgItem>
          </AdaptiveFormGrid>
          <CfgItem name="reason" label="取消原因" fixedLabel="取消原因" rules={[{ required: true, message: "请填写取消原因" }]}>
            <Input.TextArea aria-label="取消原因" rows={3} placeholder="请输入取消原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix={props.scope === "INVOID" ? "inv-void" : props.scope === "INVREFUND" ? "inv-refund" : "order-cancel"} />
        </FieldConfigScope>
      </BusinessRegistrationForm>
    </BusinessActionModal>
  );
}
