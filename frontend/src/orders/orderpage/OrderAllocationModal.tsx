import { Alert, Form, Input, Typography } from "antd";
import type { FormInstance } from "antd";
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
  ALLOCATION_TYPE_ROLE,
  allocationAmountFromRate,
  allocationRateFromAmount,
  validateAllocations,
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
  allocationProfit,
  employeeOptions,
  watchedRows,
}: {
  allocationCandidates: ActionAllocationCandidates;
  allocationForm: FormInstance;
  allocationProfit: string;
  employeeOptions: AllocationEmployeeOption[];
  watchedRows: AllocationFormRow[];
}) {
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
                      placeholder="选择动作负责人"
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
                    onChange={(event) => allocationForm.setFieldValue(
                      ["allocations", field.name, "allocation_amount"],
                      allocationAmountFromRate(allocationProfit, event.target.value),
                    )}
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
                    onChange={(event) => allocationForm.setFieldValue(
                      ["allocations", field.name, "allocation_rate"],
                      allocationRateFromAmount(allocationProfit, event.target.value),
                    )}
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
    const validation = validateAllocations(rows, allocationProfit);
    if (!validation.ok) {
      appMessage.error(validation.error);
      return;
    }
    setAllocationSubmitting(true);
    try {
      const sourceFormExtra = {
        ...(values.form_extra ?? {}),
        business_responsible_ids: [...new Set(validation.items
          .filter((item) => item.allocation_type === "BUY" && item.user_id != null)
          .map((item) => item.user_id as number))],
        delivery_responsible_ids: [...new Set(validation.items
          .filter((item) => item.allocation_type === "SELL" && item.user_id != null)
          .map((item) => item.user_id as number))],
        operation_responsible_ids: [...new Set(validation.items
          .filter((item) => item.allocation_type === "OPERATION" && item.user_id != null)
          .map((item) => item.user_id as number))],
      };
      await policyApi.setAllocations(actionOrder.id, validation.items, sourceFormExtra);
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
          按操作分配：买号、售出、运营、公司四项。每项可多选人员，只填写一次比例或金额，确认后由系统在该项人员中平分，并同步更新来源处负责人。
        </Typography.Paragraph>
        <AllocationFields
          allocationCandidates={allocationCandidates}
          allocationForm={allocationForm}
          allocationProfit={allocationProfit}
          employeeOptions={employeeOptions}
          watchedRows={watchedRows}
        />
        <FieldConfigScope scope="ALLOCATION" active={allocationOpen}>
          <CustomFieldSection testIdSuffix="order-allocation" />
        </FieldConfigScope>
      </BusinessRegistrationForm>
    </BusinessActionModal>
  );
}
