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
import type { OrdersPageController } from "./useOrdersPageController";
import {
  ALLOCATION_TYPE_LABEL,
  ALLOCATION_TYPE_ROLE,
  allocationAmountFromRate,
  allocationRateFromAmount,
  splitEven,
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
  const groupOf = (kind?: AllocationType) =>
    kind ? watchedRows.filter((row) => row.allocation_type === kind) : [];
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
            const group = groupOf(kind);
            const people = group.length;
            const shareMode = isAction ? row.share_mode ?? "PER_PERSON" : "PER_PERSON";
            const shared = isAction && shareMode === "SHARED";
            const totalRow = group.find((item) => (item.share_mode ?? "PER_PERSON") === "TOTAL");
            const shareIndex = shared ? group.indexOf(row) : -1;
            const totalRate = String(totalRow?.allocation_rate ?? "").trim();
            const totalAmount = String(totalRow?.allocation_amount ?? "").trim();
            const splitRate = totalRow && totalRate !== "" ? splitEven(Number(totalRate) || 0, people) : [];
            const splitAmount = totalRow && totalAmount !== "" ? splitEven(Number(totalAmount) || 0, people) : [];
            const company = kind === "COMPANY";
            const actionMissing = (kind === "BUY" || kind === "SELL") && !hasPosted(kind);
            const employeeDisabled = company;
            const employeeRequired = !company && (!isAction || Boolean(kind && allocationCandidates[kind].length));
            const kindLabel = kind ? ALLOCATION_TYPE_LABEL[kind] : "姓名";
            const employeeLabel = isAction && shareMode === "TOTAL" && people > 1
              ? `${kindLabel}（${people} 人均分）`
              : kindLabel;
            const split = isAction && shareMode === "TOTAL" && people > 1;

            return (
              <AdaptiveFormGrid key={field.key} className={`orders-allocation-row${isAction ? " is-action" : ""}`}>
                <Form.Item name={[field.name, "allocation_type"]} hidden><Input /></Form.Item>
                <Form.Item name={[field.name, "share_mode"]} hidden><Input /></Form.Item>
                <Form.Item
                  name={[field.name, "employee"]}
                  label={employeeLabel}
                  rules={employeeRequired ? [{ required: true, message: "请选择姓名" }] : []}
                >
                  <Select
                    placeholder={actionMissing ? "选择动作负责人" : isAction && !company ? "选择动作负责人" : "选择员工"}
                    options={company ? [{ value: "COMPANY", label: "公司（不绑定人员）" }] : optionsFor(kind, allocationCandidates, employeeOptions)}
                    disabled={employeeDisabled}
                    className="ui-control-width-200"
                  />
                </Form.Item>
                {isAction ? null : (
                  <Form.Item name={[field.name, "role"]} label="角色" initialValue="OWNER">
                    <Select options={profitRoleOptions} placeholder="选择角色" className="ui-control-width-120" />
                  </Form.Item>
                )}
                {shared ? (
                  <>
                    <Form.Item label="比例（人均）">
                      <Typography.Text className="orders-allocation-shared">
                        {splitRate.length ? `${splitRate[shareIndex] ?? 0}%` : "—"}
                      </Typography.Text>
                    </Form.Item>
                    <Form.Item label="金额（人均）">
                      <Typography.Text className="orders-allocation-shared">
                        {splitAmount.length ? money(String(splitAmount[shareIndex] ?? 0)) : "—"}
                      </Typography.Text>
                    </Form.Item>
                  </>
                ) : (
                  <>
                    <Form.Item
                      name={[field.name, "allocation_rate"]}
                      label={split ? "比例合计" : "比例"}
                      rules={isAction ? [...percentRules("比例"), { required: true, message: "请填写比例" }] : percentRules("比例")}
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
                      label={split ? "金额合计" : "金额"}
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
                  </>
                )}
                {!isAction ? (
                  <PermissionButton
                    permission="policy.manage"
                    type="link"
                    danger
                    disabled={fields.length <= 1}
                    onClick={() => remove(field.name)}
                  >删除</PermissionButton>
                ) : (
                  <PermissionButton
                    permission="policy.manage"
                    type="link"
                    danger
                    disabled={company || group.length <= 1 || shareMode === "TOTAL"}
                    onClick={() => remove(field.name)}
                  >删除人员</PermissionButton>
                )}
              </AdaptiveFormGrid>
            );
          })}
          {isAction ? (
            <div className="ui-form-actions">
              {(["BUY", "SELL", "OPERATION"] as const).map((kind) => {
                const group = groupOf(kind);
                const hasTotal = group.some((row) => (row.share_mode ?? "PER_PERSON") === "TOTAL");
                return (
                  <PermissionButton
                    key={kind}
                    permission="policy.manage"
                    type="dashed"
                    onClick={() => add({
                      allocation_type: kind,
                      role: ALLOCATION_TYPE_ROLE[kind],
                      share_mode: hasTotal ? "SHARED" : "PER_PERSON",
                      employee: undefined,
                      allocation_rate: "",
                      allocation_amount: "",
                    })}
                  >+ 增加{ALLOCATION_TYPE_LABEL[kind]}人员</PermissionButton>
                );
              })}
            </div>
          ) : (
            <PermissionButton
              permission="policy.manage"
              type="dashed"
              block
              onClick={() => add({ employee: currentEmployeeId, role: "OWNER", allocation_rate: "", allocation_amount: "" })}
            >+ 增加一行</PermissionButton>
          )}
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
            ? "按操作分配：买号、售出、运营、公司四项。人员默认取订单来源处负责人，也可在此增删和调整；保存后会同步更新来源处。一个动作有多人时，该动作的份额按人数均分，只需在首行填该动作合计。"
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
