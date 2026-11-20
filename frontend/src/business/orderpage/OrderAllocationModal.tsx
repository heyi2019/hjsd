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
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import { useKeyedLatestRequest } from "../../shared/hooks/useLatestRequest";
import { profitAllocationApi } from "../../shared/api/profitAllocation.api";
import { moneyRules } from "../../shared/lib/validators";
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
  | "employeeOptions"
  | "load"
  | "loadLedgerDetail"
  | "closeAllocations"
  | "getAllocationSession"
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
  getAllocationSession,
  orderId,
  watchedRows,
}: {
  allocationCandidates: ActionAllocationCandidates;
  allocationForm: FormInstance;
  employeeOptions: AllocationEmployeeOption[];
  getAllocationSession: () => number;
  orderId: number;
  watchedRows: AllocationFormRow[];
}) {
  const conversionVersion = useKeyedLatestRequest<number>();
  const invalidateConversion = conversionVersion.invalidate;
  const convertValue = (row: number, direction: "RATE_TO_AMOUNT" | "AMOUNT_TO_RATE", value: string, target: "allocation_rate" | "allocation_amount") => {
    const version = conversionVersion.start(row);
    const session = getAllocationSession();
    if (!value.trim()) return;
    void profitAllocationApi.convert(orderId, direction, value).then((result) => {
      if (!conversionVersion.isCurrent(row, version) || getAllocationSession() !== session) return;
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

            if (company) {
              return (
                <div key={field.key} hidden>
                  <Form.Item name={[field.name, "allocation_type"]} hidden><Input /></Form.Item>
                  <Form.Item name={[field.name, "employee_ids"]} hidden><Input /></Form.Item>
                  <Form.Item name={[field.name, "allocation_rate"]} hidden><Input /></Form.Item>
                  <Form.Item name={[field.name, "allocation_amount"]} hidden><Input /></Form.Item>
                </div>
              );
            }

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
                >
                  <Input
                    suffix="%"
                    readOnly
                    className="ui-control-width-120"
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
    employeeOptions,
    load,
    loadLedgerDetail,
    closeAllocations,
    getAllocationSession,
  } = controller;
  const watchedRows = Form.useWatch<AllocationFormRow[]>("allocations", allocationForm) ?? [];
  const write = useAsyncAction();

  const submitAllocations = async (values: AllocationFormValues) => {
    if (!actionOrder) return;
    const rows = values.allocations ?? [];
    if (rows.length === 0) {
      appMessage.error("请先在员工花名册里选择分润对象");
      return;
    }
    const session = getAllocationSession();
    await write.run(async () => {
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
        // 前端只 submit 金额：比例框已改为只读展示（由金额经 convert 反算），
        // 不再是输入口径。落库与对账都走金额，避免「展示比例」与「存库比例」两套口径并存。
        // 公司行金额留空，由后端按公司固定比例自动补金额参与合计校验。
        const payloadRows = rows.map((item) => ({
          allocation_type: item.allocation_type,
          employee_ids: item.employee_ids ?? [],
          role: item.role ?? "OWNER",
          allocation_rate: null,
          allocation_amount: item.allocation_type === "COMPANY"
            ? null
            : (item.allocation_amount?.trim() ? item.allocation_amount : null),
        }));
        await profitAllocationApi.set(actionOrder.id, payloadRows, sourceFormExtra);
        appMessage.success("分润已保存");
        const savedOrder = actionOrder;
        if (getAllocationSession() === session) closeAllocations();
        // 保存成功后先关闭弹窗，台账和详情在后台刷新；刷新失败不应误报保存失败。
        void (async () => {
          await load();
          if (savedOrder.account_id != null) await loadLedgerDetail(savedOrder, true);
        })().catch(() => appMessage.warning("分润已保存，台账刷新失败，请手动刷新"));
      } catch (error) {
        appMessage.error(normalizeError(error).message);
      }
    });
  };

  return (
    <BusinessActionModal
      title={actionOrder ? `分润 · ${actionOrder.order_no}` : "分润"}
      fieldCount={21}
      open={allocationOpen}
      confirmLoading={write.pending}
      wrapClassName="allocation-modal"
      onCancel={closeAllocations}
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
              可分配利润：<MoneyText value={allocationProfit} tone="auto" strong />
              {allocationIsLoss ? "（亏损）金额分润请填负数，表示该人分担的亏损额" : null}
            </span>
          )}
        />
        <Typography.Paragraph type="secondary">
          按操作分配：买号、售出、运营三项可多选人员，公司份额由系统按固定口径自动计入。只需填写金额，比例按占总利润自动换算供参考；确认后由系统在该项人员中平分，并同步更新来源处操作人。
        </Typography.Paragraph>
        <AllocationFields
          allocationCandidates={allocationCandidates}
          allocationForm={allocationForm}
          employeeOptions={employeeOptions}
          getAllocationSession={getAllocationSession}
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
