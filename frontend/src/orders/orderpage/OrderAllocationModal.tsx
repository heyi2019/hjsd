import { Alert, Form, Input, Typography } from "antd";
import type { FormInstance } from "antd";
import { CustomFieldSection, FieldConfigScope } from "../ConfigurableField";
import {
  AdaptiveFormGrid,
  BusinessActionModal,
  BusinessRegistrationForm,
  MoneyText,
  PermissionButton,
  Select,
} from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { money } from "../../shared/lib/format";
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
  | "allocationMode"
  | "allocationOpen"
  | "allocationProfit"
  | "allocationSubmitting"
  | "currentEmployeeId"
  | "employeeOptions"
  | "load"
  | "loadLedgerDetail"
  | "profitRoleOptions"
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
  if (kind === "BUY" || kind === "SELL" || kind === "OPERATION") {
    // candidates 只负责回显订单来源处的当前值；编辑时允许从全部在职人员中重选。
    void candidates;
    return employeeOptions.filter((option) => option.value !== "COMPANY");
  }
  return employeeOptions.filter((option) => option.value !== "COMPANY");
}

function AllocationFields({
  isAction,
  allocationCandidates,
  allocationForm,
  allocationProfit,
  currentEmployeeId,
  employeeOptions,
  profitRoleOptions,
  actionEvents,
  watchedRows,
}: {
  isAction: boolean;
  allocationCandidates: ActionAllocationCandidates;
  allocationForm: FormInstance;
  allocationProfit: string;
  currentEmployeeId?: number;
  employeeOptions: AllocationEmployeeOption[];
  profitRoleOptions: Array<{ value: string; label: string }>;
  actionEvents: Array<{ event_type: string; is_posted?: boolean }>;
  watchedRows: AllocationFormRow[];
}) {
  const hasPosted = (kind: AllocationType) =>
    (kind === "BUY" || kind === "SELL") &&
    actionEvents.some((event) => event.event_type === kind && event.is_posted);

  return (
    <Form.List name="allocations">
      {(fields, { add, remove }) => (
        <>
          {fields.map((field) => {
            const row = watchedRows[field.name] ?? {};
            const kind = isAction ? ((row.allocation_type || undefined) as AllocationType | undefined) : undefined;
            const company = kind === "COMPANY";
            const actionMissing = (kind === "BUY" || kind === "SELL") && !hasPosted(kind);
            const employeeDisabled = company;
            const employeeRequired = !company && (!isAction || Boolean(kind && allocationCandidates[kind].length));
            const kindLabel = kind ? ALLOCATION_TYPE_LABEL[kind] : "姓名";

            return (
              <AdaptiveFormGrid key={field.key} className={`orders-allocation-row${isAction ? " is-action" : ""}`}>
                <Form.Item name={[field.name, "allocation_type"]} hidden><Input /></Form.Item>
                {isAction ? (
                  company ? (
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
                        placeholder={actionMissing ? "选择动作负责人" : "选择动作负责人"}
                        options={optionsFor(kind, allocationCandidates, employeeOptions)}
                      />
                    </Form.Item>
                  )
                ) : (
                  <Form.Item
                    className="responsible-employee-select"
                    name={[field.name, "employee"]}
                    label={kindLabel}
                    rules={employeeRequired ? [{ required: true, message: "请选择姓名" }] : []}
                  >
                    <EmployeeSelectControl
                      placeholder="选择员工"
                      options={optionsFor(kind, allocationCandidates, employeeOptions)}
                    />
                  </Form.Item>
                )}
                {!isAction ? (
                  <Form.Item name={[field.name, "role"]} label="角色" initialValue="OWNER">
                    <Select options={profitRoleOptions} placeholder="选择角色" className="ui-control-width-120" />
                  </Form.Item>
                ) : null}
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
                {!isAction ? (
                  <PermissionButton
                    permission="policy.manage"
                    type="link"
                    danger
                    disabled={fields.length <= 1}
                    onClick={() => remove(field.name)}
                  >删除</PermissionButton>
                ) : null}
              </AdaptiveFormGrid>
            );
          })}
          {!isAction ? (
            <PermissionButton
              permission="policy.manage"
              type="dashed"
              block
              onClick={() => add({ employee: currentEmployeeId, role: "OWNER", allocation_rate: "", allocation_amount: "" })}
            >+ 增加一行</PermissionButton>
          ) : null}
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
    allocationMode,
    allocationOpen,
    allocationProfit,
    allocationSubmitting,
    currentEmployeeId,
    employeeOptions,
    load,
    loadLedgerDetail,
    profitRoleOptions,
    setActionOrder,
    setAllocationOpen,
    setAllocationSubmitting,
  } = controller;
  const isAction = allocationMode === "ACTION";
  const watchedRows = Form.useWatch<AllocationFormRow[]>("allocations", allocationForm) ?? [];

  const submitAllocations = async (values: AllocationFormValues) => {
    if (!actionOrder) return;
    const allRows = values.allocations ?? [];
    const rows = isAction
      ? allRows
      : allRows.filter((row) => row.employee !== undefined && row.employee !== null);
    if (rows.length === 0) {
      appMessage.error("请先在员工花名册里选择分润对象");
      return;
    }
    const validation = validateAllocations(rows, allocationProfit, allocationMode);
    if (!validation.ok) {
      appMessage.error(validation.error);
      return;
    }
    setAllocationSubmitting(true);
    try {
      const sourceFormExtra = isAction
        ? {
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
          }
        : values.form_extra;
      await policyApi.setAllocations(actionOrder.id, validation.items, sourceFormExtra);
      appMessage.success("分润已保存");
      await load();
      if (actionOrder.account_id != null) await loadLedgerDetail(actionOrder.account_id, true);
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
          {isAction
            ? "按操作分配：买号、售出、运营、公司四项。每项可多选人员，只填写一次比例或金额，确认后由系统在该项人员中平分，并同步更新来源处负责人。"
            : "每行一位员工：比例和金额任填其一，填写任一项会按本单利润双向换算，最后编辑的一项为准。纯比例分润时合计须为 100%，用金额时剩余部分默认留在公司。亏损单按金额分润请填负数。"}
        </Typography.Paragraph>
        <AllocationFields
          isAction={isAction}
          allocationCandidates={allocationCandidates}
          allocationForm={allocationForm}
          allocationProfit={allocationProfit}
          currentEmployeeId={currentEmployeeId}
          employeeOptions={employeeOptions}
          profitRoleOptions={profitRoleOptions}
          actionEvents={actionOrder?.events ?? []}
          watchedRows={watchedRows}
        />
        <FieldConfigScope scope="ALLOCATION" active={allocationOpen}>
          <CustomFieldSection testIdSuffix="order-allocation" />
        </FieldConfigScope>
      </BusinessRegistrationForm>
    </BusinessActionModal>
  );
}
