import { Alert, Form, Input, Typography } from "antd";
import type { FormInstance } from "antd";
import { useRef } from "react";
import { CustomFieldSection, FieldConfigScope } from "../ConfigurableField";
import {
  AdaptiveFormGrid,
  BusinessActionModal,
  BusinessRegistrationForm,
  MoneyText,
} from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { policyApi } from "../../shared/api/policy.api";
import { moneyRules, percentRules } from "../../shared/lib/validators";
import { EmployeeSelectControl } from "../ResponsibleEmployeeSelect";
import type { OrdersPageController } from "./useOrdersPageController";
import {
  ALLOCATION_TYPE_LABEL,
  type ActionAllocationCandidates,
  type AllocationFormRow,
  type AllocationType,
} from "./helpers";

type AllocationController = Pick<OrdersPageController,
  | "actionOrder"
  | "allocationCandidates"
  | "allocationForm"
  | "allocationIsLoss"
  | "allocationOpen"
  | "allocationProfit"
  | "allocationSubmitting"
  | "employeeOptions"
  | "load"
  | "loadLedgerDetail"
  | "setActionOrder"
  | "setAllocationOpen"
  | "setAllocationSubmitting"
>;

type AllocationFormValues = {
  allocations: AllocationFormRow[];
  form_extra?: Record<string, unknown>;
};

type AllocationEmployeeOption = AllocationController["employeeOptions"][number];

function optionsFor(
  kind: AllocationType | undefined,
  candidates: ActionAllocationCandidates,
  employeeOptions: AllocationEmployeeOption[],
) {
  if (kind === "BUY" || kind === "SELL") {
    const candidateIds = new Set(candidates[kind]);
    return employeeOptions.filter((option) => typeof option.value === "number" && candidateIds.has(option.value));
  }
  return employeeOptions.filter((option) => option.value !== "COMPANY");
}

function AllocationFields({
  allocationCandidates,
  allocationForm,
  employeeOptions,
  orderId,
  watchedRows,
}: {
  allocationCandidates: ActionAllocationCandidates;
  allocationForm: FormInstance;
  employeeOptions: AllocationEmployeeOption[];
  orderId: number;
  watchedRows: AllocationFormRow[];
}) {
  const conversionVersion = useRef<Record<number, number>>({});
  const invalidateConversion = (row: number) => {
    conversionVersion.current[row] = (conversionVersion.current[row] ?? 0) + 1;
  };
  const convertValue = (row: number, direction: "RATE_TO_AMOUNT" | "AMOUNT_TO_RATE", value: string, target: "allocation_rate" | "allocation_amount") => {
    invalidateConversion(row);
    const version = conversionVersion.current[row];
    if (!value.trim()) return;
    void policyApi.convertAllocation(orderId, direction, value).then((result) => {
      if (conversionVersion.current[row] !== version) return;
      allocationForm.setFieldValue(["allocations", row, target], result.value ?? "");
    }).catch(() => undefined);
  };
  return (
    <Form.List name="allocations">
      {(fields) => (
        <>
          {fields.map((field) => {
            const row = watchedRows[field.name] ?? {};
            const kind = (row.allocation_type || undefined) as AllocationType | undefined;
            const company = kind === "COMPANY";
            const employeeRequired = !company && Boolean(kind && allocationCandidates[kind].length);
            const kindLabel = kind ? ALLOCATION_TYPE_LABEL[kind] : "姓名";

            return (
              <AdaptiveFormGrid key={field.key} className="orders-allocation-row is-action">
                <Form.Item name={[field.name, "allocation_type"]} hidden><Input /></Form.Item>
                {company ? (
                  <Form.Item
                    className="responsible-employee-select"
                    name={[field.name, "employee"]}
                    label={kindLabel}
                  >
                    <EmployeeSelectControl
                      placeholder="公司归属"
                      options={[{ value: "COMPANY", label: "公司（不绑定人员）" }]}
                      disabled
                    />
                  </Form.Item>
                ) : (
                  <Form.Item
                    className="responsible-employee-select"
                    name={[field.name, "employee_ids"]}
                    label={kindLabel}
                    rules={employeeRequired ? [{ required: true, message: "请选择姓名" }] : []}
                  >
                    <EmployeeSelectControl
                      mode="multiple"
                      placeholder="选择动作操作人"
                      options={optionsFor(kind, allocationCandidates, employeeOptions)}
                    />
                  </Form.Item>
                )}
                <Form.Item
                  name={[field.name, "allocation_rate"]}
                  label="比例"
                  rules={percentRules("比例")}
                >
                  <Input
                    suffix="%"
                    inputMode="decimal"
                    className="ui-control-width-120"
                    onChange={() => invalidateConversion(field.name)}
                    onBlur={(event) => convertValue(field.name, "RATE_TO_AMOUNT", event.target.value, "allocation_amount")}
                  />
                </Form.Item>
                <Form.Item
                  name={[field.name, "allocation_amount"]}
                  label="金额"
                  rules={moneyRules("金额", { allowNegative: true })}
                >
                  <Input
                    prefix="¥"
                    inputMode="decimal"
                    className="ui-control-width-140"
                    onChange={() => invalidateConversion(field.name)}
                    onBlur={(event) => convertValue(field.name, "AMOUNT_TO_RATE", event.target.value, "allocation_rate")}
                  />
                </Form.Item>
              </AdaptiveFormGrid>
            );
          })}
        </>
      )}
    </Form.List>
  );
}

export function AllocationModal({ controller }: { controller: AllocationController }) {
  const {
    actionOrder,
    allocationCandidates,
    allocationForm,
    allocationIsLoss,
    allocationOpen,
    allocationProfit,
    allocationSubmitting,
    employeeOptions,
    load,
    loadLedgerDetail,
    setActionOrder,
    setAllocationOpen,
    setAllocationSubmitting,
  } = controller;
  const watchedRows = Form.useWatch<AllocationFormRow[]>("allocations", allocationForm) ?? [];

  const submitAllocations = async (values: AllocationFormValues) => {
    if (!actionOrder) return;
    const rows = values.allocations ?? [];
    if (rows.length === 0) {
      appMessage.error("请先在员工花名册里选择分润对象");
      return;
    }
    setAllocationSubmitting(true);
    try {
      const sourceFormExtra = {
        ...(values.form_extra ?? {}),
        business_responsible_ids: [...new Set(rows
          .filter((item) => item.allocation_type === "BUY")
          .flatMap((item) => item.employee_ids ?? []))],
        delivery_responsible_ids: [...new Set(rows
          .filter((item) => item.allocation_type === "SELL")
          .flatMap((item) => item.employee_ids ?? []))],
        operation_responsible_ids: [...new Set(rows
          .filter((item) => item.allocation_type === "OPERATION")
          .flatMap((item) => item.employee_ids ?? []))],
      };
      const payloadRows = rows.map((item) => ({
        allocation_type: item.allocation_type,
        employee_ids: item.employee_ids ?? [],
        role: item.role ?? "OWNER",
        allocation_rate: item.allocation_rate?.trim() ? item.allocation_rate : null,
        allocation_amount: item.allocation_amount?.trim() ? item.allocation_amount : null,
      }));
      await policyApi.setAllocations(actionOrder.id, payloadRows, sourceFormExtra);
      appMessage.success("分润已保存");
      await load();
      if (actionOrder.account_id != null) await loadLedgerDetail(actionOrder, true);
      setAllocationOpen(false);
      setActionOrder(null);
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    } finally {
      setAllocationSubmitting(false);
    }
  };

  return (
    <BusinessActionModal
      title={actionOrder ? `分润 · ${actionOrder.order_no}` : "分润"}
      fieldCount={21}
      open={allocationOpen}
      confirmLoading={allocationSubmitting}
      wrapClassName="allocation-modal"
      onCancel={() => { setAllocationOpen(false); setActionOrder(null); }}
      onOk={() => void allocationForm.submit()}
    >
      <BusinessRegistrationForm
        layout="horizontal"
        labelAlign="left"
        labelCol={{ flex: "108px" }}
        wrapperCol={{ flex: "auto" }}
        scope="ALLOCATION"
        form={allocationForm}
        onFinish={(values) => void submitAllocations(values as AllocationFormValues)}
      >
        <Alert
          className="ui-form-spaced"
          type={allocationIsLoss ? "warning" : "info"}
          showIcon
          message={(
            <span>
              订单总利润：<MoneyText value={allocationProfit} tone="auto" strong />
              {allocationIsLoss ? "（亏损）金额分润请填负数，表示该人分担的亏损额" : null}
            </span>
          )}
        />
        <Typography.Paragraph type="secondary">
          按操作分配：买号、售出、运营、公司四项。每项可多选人员，只填写一次比例或金额，确认后由系统在该项人员中平分，并同步更新来源处操作人。
        </Typography.Paragraph>
        <AllocationFields
          allocationCandidates={allocationCandidates}
          allocationForm={allocationForm}
          employeeOptions={employeeOptions}
          orderId={actionOrder?.id ?? 0}
          watchedRows={watchedRows}
        />
        <FieldConfigScope scope="ALLOCATION" active={allocationOpen}>
          <CustomFieldSection testIdSuffix="order-allocation" />
        </FieldConfigScope>
      </BusinessRegistrationForm>
    </BusinessActionModal>
  );
}
