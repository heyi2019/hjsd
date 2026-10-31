import type { FormInstance } from "antd/es/form";
import type { ReactNode } from "react";
import { Input } from "antd";
import type { Pool } from "../shared/api/catalog";
import type { EmployeeOption } from "../shared/api/catalog";
import {
  AdaptiveFormGrid,
  BusinessActionModal,
  BusinessForm,
  MoneyInput,
  Select,
} from "../shared/ui";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../orders/ConfigurableField";
import { money } from "../shared/lib/format";
import { ResponsibleEmployeeSelect } from "../orders/ResponsibleEmployeeSelect";

export type InventoryCancellationOffset = {
  value: number;
  label: string;
  remaining: string;
  pool_id?: number;
};

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
  employees?: EmployeeOption[];
  offsetEvents?: InventoryCancellationOffset[];
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
  const offsetLabel = props.scope === "INVREFUND" ? "入库流水" : "售出流水";
  const operatorLabel = props.scope === "INVREFUND" ? "入账操作人" : "退款操作人";
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
      <BusinessForm scope={props.scope} form={props.form} onFinish={props.onFinish}>
        <div className="inventory-cancellation-note">{props.description}</div>
        <FieldConfigScope scope={props.scope} active={props.open}>
          <AdaptiveFormGrid className="inventory-void-fields">
            {props.offsetEvents?.length ? (
              <CfgItem
                alwaysActive
                name="offset_event_id"
                label={offsetLabel}
                fixedLabel={offsetLabel}
                rules={[{ required: true, message: `请选择${offsetLabel}` }]}
              >
                <Select
                  placeholder={`请选择${offsetLabel}`}
                  options={props.offsetEvents.map((event) => ({ value: event.value, label: event.label }))}
                  onChange={(value: number) => {
                    const target = props.offsetEvents?.find((event) => event.value === value);
                    if (target) {
                      const setFieldValue = props.form.setFieldValue as (name: string, value: unknown) => void;
                      setFieldValue("amount", target.remaining);
                      if (target.pool_id != null) setFieldValue("pool_id", target.pool_id);
                    }
                  }}
                />
              </CfgItem>
            ) : null}
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
            {props.employees ? <ResponsibleEmployeeSelect name="operator_user_ids" label={operatorLabel} employees={props.employees} className="order-cancel-employee" /> : null}
          </AdaptiveFormGrid>
          <CfgItem alwaysActive name="reason" label="取消原因" fixedLabel="取消原因" rules={[{ required: true, message: "请填写取消原因" }]}>
            <Input.TextArea aria-label="取消原因" rows={3} placeholder="请输入取消原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix={props.scope === "INVOID" ? "inv-void" : props.scope === "INVREFUND" ? "inv-refund" : "order-cancel"} />
        </FieldConfigScope>
      </BusinessForm>
    </BusinessActionModal>
  );
}
