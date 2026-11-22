import { Alert, Button, Form, Input } from "antd";
import { useEffect, useState } from "react";
import { OrderDetailDialog } from "../shared/order-detail/OrderDetailDialog";
import "./OrderAllocationModal.css";
import type { FormInstance } from "antd";
import { CustomFieldSections, FieldConfigScope } from "../../shared/forms/ConfigurableField";
import {
  AdaptiveFormGrid,
  BusinessActionModal,
  BusinessRegistrationForm,
  MoneyInput,
  MoneyText,
} from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import { useKeyedLatestRequest } from "../../shared/hooks/useLatestRequest";
import { profitAllocationApi } from "../../shared/api/profitAllocation.api";
import { moneyRules } from "../../shared/lib/validators";
import { formExtraOrUndefined } from "../../shared/lib/formExtra";
import { EmployeeSelectControl } from "../../shared/forms/ResponsibleEmployeeSelect";
import type { Order } from "../../shared/api/types/orders";
import type { useProfitAllocation } from "./useProfitAllocation";
import {
  ALLOCATION_TYPE_LABEL,
  buildAllocationOptionGroups,
  type ActionAllocationCandidates,
  type AllocationFormRow,
  type AllocationType,
} from "./allocationHelpers";

type AllocationController = ReturnType<typeof useProfitAllocation> & {
  load: () => Promise<void>;
  loadLedgerDetail: (order: Pick<Order, "id" | "account_id">, force?: boolean) => Promise<void>;
};

type AllocationFormValues = {
  allocations: AllocationFormRow[];
  form_extra?: Record<string, unknown>;
};

type AllocationEmployeeOption = AllocationController["employeeOptions"][number];

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
  const optionGroups = buildAllocationOptionGroups(allocationCandidates, employeeOptions);
  const invalidateConversion = conversionVersion.invalidate;
  const convertValue = (row: number, direction: "RATE_TO_AMOUNT" | "AMOUNT_TO_RATE", value: string, target: "allocation_rate" | "allocation_amount") => {
    const version = conversionVersion.start(row);
    const session = getAllocationSession();
    if (!value.trim()) return;
    void profitAllocationApi.convert(orderId, direction, value).then((result) => {
      if (!conversionVersion.isCurrent(row, version) || getAllocationSession() !== session) return;
      if (result.value == null) { appMessage.error("分润比例换算失败，请重试"); return; }
      allocationForm.setFieldValue(["allocations", row, target], result.value);
    }).catch(() => {
      if (conversionVersion.isCurrent(row, version) && getAllocationSession() === session) appMessage.error("分润比例换算失败，请重试");
    });
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
                      options={kind === "BUY" || kind === "SELL" ? optionGroups[kind] : optionGroups.other}
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
                  <MoneyInput
                    prefix="¥"
                    suffix=""
                    className="ui-control-width-140"
                    onChange={() => { invalidateConversion(field.name); allocationForm.setFieldValue(["allocations", field.name, "allocation_rate"], ""); }}
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

export function AllocationModal({ controller, onNavigate }: { controller: AllocationController; onNavigate?: (key: string) => void }) {
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
  const [showOrderDetail, setShowOrderDetail] = useState(false);
  useEffect(() => { setShowOrderDetail(false); }, [allocationOpen, actionOrder?.id]);

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
        const amountsChanged = rows.some((_, index) => allocationForm.isFieldTouched(["allocations", index, "allocation_amount"]));
        const payloadRows = rows.map((item) => ({
          allocation_type: item.allocation_type,
          employee_ids: item.employee_ids ?? [],
          role: item.role ?? "OWNER",
          allocation_rate: item.allocation_rate?.trim() || null,
          allocation_amount: item.allocation_amount?.trim() || null,
        }));
        await profitAllocationApi.set(actionOrder.id, payloadRows, formExtraOrUndefined(values.form_extra), amountsChanged);
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
    <>
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
            <span className="allocation-profit-summary">
              <span>可分配利润：<MoneyText value={allocationProfit} tone="auto" strong />
                {allocationIsLoss ? "（亏损）金额分润请填负数，表示该人分担的亏损额" : null}
              </span>
              <Button htmlType="button" onClick={() => setShowOrderDetail(true)}>查看订单详情</Button>
            </span>
          )}
        />
        <AllocationFields
          allocationCandidates={allocationCandidates}
          allocationForm={allocationForm}
          employeeOptions={employeeOptions}
          getAllocationSession={getAllocationSession}
          orderId={actionOrder?.id ?? 0}
          watchedRows={watchedRows}
        />
        <FieldConfigScope scope="ALLOCATION" active={allocationOpen}>
          <CustomFieldSections testIdSuffix="order-allocation" />
        </FieldConfigScope>
      </BusinessRegistrationForm>
    </BusinessActionModal>
    {allocationOpen && actionOrder && showOrderDetail && <OrderDetailDialog orderId={actionOrder.id} onClose={() => setShowOrderDetail(false)} onPartyNavigate={onNavigate ? (path) => { closeAllocations(); onNavigate(path.replace(/^\//, "")); } : undefined} />}
    </>
  );
}
