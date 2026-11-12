import { type AllocationFormRow, ALLOCATION_TYPE_LABEL, allocationAmountFromRate, allocationRateFromAmount, splitEven, validateAllocations, type AllocationType } from "./helpers";
import { Alert, Form, Input, Typography } from "antd";
import { CustomFieldSection, FieldConfigScope } from "../ConfigurableField";
import { MoneyText, PermissionButton, Select, AdaptiveFormGrid, BusinessActionModal, BusinessRegistrationForm } from "../../shared/ui";
import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { money } from "../../shared/lib/format";
import { policyApi } from "../../shared/api/policy.api";
import { percentRules, moneyRules } from "../../shared/lib/validators";
import { type OrdersPageController } from "./useOrdersPageController";

export function AllocationModal({ controller }: { controller: OrdersPageController }) {
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
    loadLedgerDetail,
    profitRoleOptions,
    setActionOrder,
    setAllocationOpen,
    setAllocationSubmitting,
  } = controller;
  const isAction = allocationMode === "ACTION";
  // 表单值实时镜像：一个动作多人时，第 2 人及以后的行要跟着首行的「合计」实时算出人均值。
  const watchedRows = Form.useWatch<AllocationFormRow[]>("allocations", allocationForm) ?? [];
  const groupOf = (kind?: AllocationType) =>
    kind ? watchedRows.filter((row) => row.allocation_type === kind) : [];
  /** 本单是否有已过账的买号/售出动作；没有的动作位不给填人。 */
  const hasPosted = (kind: AllocationType) =>
    (kind === "BUY" || kind === "SELL") &&
    (actionOrder?.events ?? []).some((event) => event.event_type === kind && event.is_posted);
  const staffOptions = employeeOptions.filter((option) => option.value !== "COMPANY");
  /**
   * 按操作四项的人员只能取业务事实上已登记的执行人：
   * 买号看业务负责人、售出看交付负责人、运营看运营负责人或运营类事件的操作人。
   * 没有候选时返回空（不退回全部员工）——人员编辑入口只在账号台账与库存中心，
   * 这里留空即表示该动作尚未登记负责人，由页面提示去台账补，而不是就地挑一个人。
   */
  const optionsFor = (kind?: AllocationType) => {
    if (kind === "BUY" || kind === "SELL" || kind === "OPERATION") {
      const ids = allocationCandidates[kind];
      return employeeOptions.filter(
        (option) => typeof option.value === "number" && ids.includes(option.value),
      );
    }
    return staffOptions;
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
          onFinish={async (values: { allocations: AllocationFormRow[]; form_extra?: Record<string, unknown> }) => {
            if (!actionOrder) return;
            const allRows = values.allocations ?? [];
            // 按操作四项是固定结构，缺人的行也要保留（由后端判断该项是否允许为空）。
            const rows = isAction
              ? allRows
              : allRows.filter((row) => row.employee !== undefined && row.employee !== null);
            if (rows.length === 0) {
              appMessage.error("请先在员工花名册里选择分润对象");
              return;
            }
            const result = validateAllocations(rows, allocationProfit, allocationMode);
            if (!result.ok) {
              appMessage.error(result.error);
              return;
            }
            const items = result.items;
            setAllocationSubmitting(true);
            try {
              await policyApi.setAllocations(actionOrder.id, items, values.form_extra);
              appMessage.success("分润已保存");
              // L266：刷新订单详情，使分润明细在订单展开详情中回显（详情由 ledgerDetails 缓存驱动）。
              if (actionOrder.account_id != null) await loadLedgerDetail(actionOrder.account_id, true);
              setAllocationOpen(false);
              setActionOrder(null);
            } catch (error) {
              appMessage.error(normalizeError(error).message);
            } finally {
              setAllocationSubmitting(false);
            }
          }}
        >
          <Alert
            className="ui-form-spaced"
            type={allocationIsLoss ? "warning" : "info"}
            showIcon
            message={
              <span>
                订单总利润：
                <MoneyText value={allocationProfit} tone="auto" strong />
                {allocationIsLoss ? "（亏损）金额分润请填负数，表示该人分担的亏损额" : null}
              </span>
            }
          />
          <Typography.Paragraph type="secondary">
            {isAction
              ? "按操作分配：买号、售出、运营、公司四项。人员已锁定为账号台账 / 库存中心登记的执行人（买号=业务负责人、售出=交付负责人、运营=运营负责人）。一个动作有多人时，该动作的份额按人数均分（2 人各半、3 人各三分之一），只需在首行填该动作合计。台账之后增删执行人，这里的人数与均分会自动跟着变，合计不变；需要换人请到账号台账或库存中心修改。"
              : "每行一位员工：比例和金额任填其一，填写任一项会按本单利润双向换算，最后编辑的一项为准。纯比例分润时合计须为 100%，用金额时剩余部分默认留在公司。亏损单按金额分润请填负数（如 -300 表示分担 300 亏损）。"}
          </Typography.Paragraph>
          <Form.List name="allocations">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => {
                  const row = watchedRows[field.name] ?? {};
                  const kind = isAction ? ((row.allocation_type || undefined) as AllocationType | undefined) : undefined;
                  const group = groupOf(kind);
                  const people = group.length;
                  const shareMode = isAction ? row.share_mode ?? "PER_PERSON" : "PER_PERSON";
                  // 同一动作的第 2 人及以后：不给输入，直接显示「合计 ÷ 人数」。
                  const shared = isAction && shareMode === "SHARED";
                  const totalRow = group.find((item) => (item.share_mode ?? "PER_PERSON") === "TOTAL");
                  const shareIndex = shared ? group.indexOf(row) : -1;
                  // 合计那一栏没填就不显示 0，避免「未填」看起来像「分了 0 元」。
                  const totalRateText = String(totalRow?.allocation_rate ?? "").trim();
                  const totalAmountText = String(totalRow?.allocation_amount ?? "").trim();
                  const splitRate = totalRow && totalRateText !== "" ? splitEven(Number(totalRateText) || 0, people) : [];
                  const splitAmount = totalRow && totalAmountText !== "" ? splitEven(Number(totalAmountText) || 0, people) : [];
                  // 公司位不绑人；本单没有的动作位（如代挂无买号）也不给填。
                  const company = kind === "COMPANY";
                  const actionMissing = (kind === "BUY" || kind === "SELL") && !hasPosted(kind);
                  // 按操作四项的人员一律锁定为台账登记的执行人：分润只分钱、不编人。
                  // 人员编辑入口只在账号台账与库存中心，避免两处口径打架。
                  const employeeDisabled = isAction || company || actionMissing;
                  const kindLabel = kind ? ALLOCATION_TYPE_LABEL[kind] : "姓名";
                  const employeeLabel = isAction && shareMode === "TOTAL" && people > 1 ? `${kindLabel}（${people} 人均分）` : kindLabel;
                  const split = isAction && shareMode === "TOTAL" && people > 1;
                  return (
                    <AdaptiveFormGrid key={field.key} className={`orders-allocation-row${isAction ? " is-action" : ""}`}>
                      <Form.Item name={[field.name, "allocation_type"]} hidden>
                        <Input />
                      </Form.Item>
                      <Form.Item name={[field.name, "share_mode"]} hidden>
                        <Input />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "employee"]}
                        label={employeeLabel}
                        rules={employeeDisabled ? [] : [{ required: true, message: "请选择姓名" }]}
                      >
                        <Select
                          placeholder={actionMissing ? "本单无此动作" : isAction && !company ? "由台账登记的执行人决定" : "选择员工"}
                          options={company ? [{ value: "COMPANY", label: "公司（不绑定人员）" }] : optionsFor(kind)}
                          disabled={employeeDisabled}
                          className="ui-control-width-200"
                        />
                      </Form.Item>
                      {isAction ? null : (
                        <Form.Item name={[field.name, "role"]} label="角色" initialValue="OWNER">
                          <Select
                            placeholder="选择角色"
                            options={profitRoleOptions}
                            className="ui-control-width-120"
                          />
                        </Form.Item>
                      )}
                      {shared ? (
                        <>
                          <Form.Item label="比例（人均）">
                            <Typography.Text className="orders-allocation-shared">{splitRate.length ? `${splitRate[shareIndex] ?? 0}%` : "—"}</Typography.Text>
                          </Form.Item>
                          <Form.Item label="金额（人均）">
                            <Typography.Text className="orders-allocation-shared">{splitAmount.length ? money(String(splitAmount[shareIndex] ?? 0)) : "—"}</Typography.Text>
                          </Form.Item>
                        </>
                      ) : (
                        <>
                          <Form.Item
                            name={[field.name, "allocation_rate"]}
                            label={split ? "比例合计" : "比例"}
                            rules={
                              isAction
                                ? [...percentRules("比例"), { required: true, message: "请填写比例" }]
                                : percentRules("比例")
                            }
                          >
                            <Input
                              suffix="%"
                              inputMode="decimal"
                              className="ui-control-width-120"
                              onChange={(event) => {
                                allocationForm.setFieldValue(
                                  ["allocations", field.name, "allocation_amount"],
                                  allocationAmountFromRate(allocationProfit, event.target.value),
                                );
                              }}
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
                              onChange={(event) => {
                                allocationForm.setFieldValue(
                                  ["allocations", field.name, "allocation_rate"],
                                  allocationRateFromAmount(allocationProfit, event.target.value),
                                );
                              }}
                            />
                          </Form.Item>
                        </>
                      )}
                      {!isAction ? (
                        <>
                          <PermissionButton
                            permission="policy.manage"
                            type="link"
                            danger
                            disabled={fields.length <= 1}
                            onClick={() => remove(field.name)}
                          >
                            删除
                          </PermissionButton>
                        </>
                      ) : null}
                    </AdaptiveFormGrid>
                  );
                })}
                {isAction ? null : (
                  <PermissionButton
                    permission="policy.manage"
                    type="dashed"
                    block
                    onClick={() => add({ employee: currentEmployeeId, role: "OWNER", allocation_rate: "", allocation_amount: "" })}
                  >
                    + 增加一行
                  </PermissionButton>
                )}
              </>
            )}
          </Form.List>
          <FieldConfigScope scope="ALLOCATION" active={allocationOpen}>
            <CustomFieldSection testIdSuffix="order-allocation" />
          </FieldConfigScope>
        </BusinessRegistrationForm>
      </BusinessActionModal>
  );
}
