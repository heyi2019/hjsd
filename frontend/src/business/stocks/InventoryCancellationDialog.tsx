import type { FormInstance } from "antd/es/form";
import type { ReactNode } from "react";
import { Form, Input } from "antd";
import type { Pool } from "../../shared/api/types/finance";
import type { EmployeeOption } from "../../shared/api/types/org";
import {
  AdaptiveFormGrid,
  BusinessActionModal,
  BusinessRegistrationForm,
  MoneyInput,
  Select,
} from "../../shared/ui";
import { CfgItem, CustomFieldSections, FieldConfigScope } from "../ConfigurableField";
import { money } from "../../shared/lib/format";
import { compareMoney } from "../../shared/lib/money";
import { moneyRules } from "../../shared/lib/validators";
import { ResponsibleEmployeeSelect } from "../ResponsibleEmployeeSelect";

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

/**
 * 切换冲销流水后的字段回填（纯函数，供组件与单测共用）。
 * - 金额取新流水剩余；
 * - 资金账户无条件回填：新流水无池时清空，不能残留上一笔的账户（#19）；
 * - 操作人属本次冲销动作，重置为默认值；未给默认值则清空，由写路径兜底按当前会话解析。
 */
export function applyOffsetEventSelection(
  setFieldValue: (name: string, value: unknown) => void,
  target: { remaining: string; pool_id?: number } | undefined,
  defaultOperatorUserIds?: number[],
): void {
  if (!target) return;
  setFieldValue("amount", target.remaining);
  setFieldValue("pool_id", target.pool_id ?? undefined);
  setFieldValue("operator_user_ids", defaultOperatorUserIds ?? undefined);
}

export function InventoryCancellationDialog<T extends InventoryCancellationValues>(props: {
  open: boolean;
  title: string;
  amount: string;
  pools: Pool[];
  employees?: EmployeeOption[];
  offsetEvents?: InventoryCancellationOffset[];
  /** 切换冲销流水时操作人重置到此默认值；未传则清空，由写路径兜底解析当前员工。 */
  defaultOperatorUserIds?: number[];
  form: FormInstance<T>;
  scope: "INVOID" | "INVREFUND" | "ORDERCANC";
  description: ReactNode;
  okText: string;
  amountLabel?: string;
  accountLabel?: string;
  submitting?: boolean;
  allowZeroRefund?: boolean;
  onCancel: () => void;
  onFinish: (values: T) => void | Promise<void>;
}) {
  const refundAmount = Form.useWatch("amount", props.form);
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
      <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope={props.scope} form={props.form} onFinish={props.onFinish}>
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
                    applyOffsetEventSelection(
                      props.form.setFieldValue as (name: string, value: unknown) => void,
                      target,
                      props.defaultOperatorUserIds,
                    );
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
                ...moneyRules(amountLabel),
                { validator: async (_, value) => {
                  const amount = String(value ?? "");
                  const positive = compareMoney(amount, "0");
                  const comparison = compareMoney(amount, props.amount);
                  if (positive === null || (props.allowZeroRefund ? positive < 0 : positive <= 0) || comparison === null) throw new Error(`请输入${props.allowZeroRefund ? "不小于" : "大于"} 0 的${amountLabel}`);
                  if (comparison > 0) throw new Error(`${amountLabel}不能超过 ¥${money(props.amount)}`);
                } },
              ]}
            >
              <MoneyInput aria-label={amountLabel} placeholder={`请输入${amountLabel}`} />
            </CfgItem>
            {(!props.allowZeroRefund || Number(refundAmount) > 0) && <CfgItem alwaysActive name="pool_id" label={accountLabel} fixedLabel={accountLabel} rules={[{ required: true, message: `请选择${accountLabel}` }]}>
              <Select placeholder={`请选择${accountLabel}`} options={props.pools.map((pool) => ({ value: pool.id, label: pool.name }))} notFoundContent={`暂无可用${accountLabel}`} />
            </CfgItem>}
            {props.employees ? <ResponsibleEmployeeSelect name="operator_user_ids" label={operatorLabel} employees={props.employees} className="order-cancel-employee" /> : null}
          </AdaptiveFormGrid>
          <CfgItem alwaysActive name="reason" label="取消原因" fixedLabel="取消原因" rules={[{ required: true, whitespace: true, message: "请填写取消原因" }]}>
            <Input.TextArea aria-label="取消原因" rows={3} placeholder="请输入取消原因" />
          </CfgItem>
          <CustomFieldSections testIdSuffix={props.scope === "INVOID" ? "inv-void" : props.scope === "INVREFUND" ? "inv-refund" : "order-cancel"} />
        </FieldConfigScope>
      </BusinessRegistrationForm>
    </BusinessActionModal>
  );
}
