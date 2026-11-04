import dayjs, { type Dayjs } from "dayjs";
import type { AllocationFormRow } from "./helpers";
import { Alert, DatePicker, Form, Input, Typography } from "antd";
import { ALLOCATION_TYPE_LABEL, buildActionAllocationRows, buildRefundEventPayload, validateAllocations, type AllocationMode, type AllocationType } from "./helpers";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../ConfigurableField";
import { CreateBusinessModal } from "../CreateBusinessModal";
import { DateField, MoneyInput, MoneyText, PermissionButton, Select, AdaptiveFormGrid, BusinessActionModal, BusinessRegistrationForm, dateValueFromEvent, dateValueProps } from "../../shared/ui";
import { ResponsibleEmployeeSelect } from "../ResponsibleEmployeeSelect";
import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { executionActionLabel, money, today } from "../../shared/lib/format";
import { ordersApi, policyApi } from "../../shared/api/catalog";
import { requiredMoneyRules, percentRules, moneyRules } from "../../shared/lib/validators";
import { InventoryCancellationDialog } from "../../stocks/InventoryCancellationDialog";
import type { OrdersPageController } from "./useOrdersPageController";

export function SharedCancellationDialog({ controller }: { controller: OrdersPageController }) {
  const {
    cancelForm,
    cancelOrderTarget,
    cancelPools,
    cancelScope,
    cancelSubmitting,
    closeCancelTransaction,
    hasSharedCancellation,
    sharedCancellationEvent,
    submitCancelTransaction,
  } = controller;
  return (
    <InventoryCancellationDialog
      open={hasSharedCancellation}
      title={cancelOrderTarget ? `取消 · ${cancelOrderTarget.order_no}` : "取消"}
      amount={sharedCancellationEvent?.remaining ?? "0.00"}
      pools={cancelPools}
      form={cancelForm}
      scope={cancelScope}
      submitting={cancelSubmitting}
      okText="确认取消"
      amountLabel={cancelScope === "INVREFUND" ? "退回金额" : "退款金额"}
      accountLabel={cancelScope === "INVREFUND" ? "收款账户" : "付款账户"}
      onCancel={closeCancelTransaction}
      onFinish={(values) => void submitCancelTransaction({ ...values, cancelled_on: today() })}
      description={cancelScope === "INVREFUND"
        ? <p className="muted">将冲销来源订单的买入流水（¥{money(sharedCancellationEvent?.remaining ?? "0.00")}），退回金额进入所选收款账户；订单状态变为「取消」并退出在库统计。取消不可撤销，历史轨迹保留。</p>
        : <p className="muted">将冲销来源订单的售出流水（¥{money(sharedCancellationEvent?.remaining ?? "0.00")}），退款金额将从所选付款账户支出；订单状态变为「取消」，历史轨迹保留。</p>}
    />
  );
}

export function CancelTransactionModal({ controller }: { controller: OrdersPageController }) {
  const {
    cancelEmployees,
    cancelForm,
    cancelInstallmentTarget,
    cancelOrderTarget,
    cancelPools,
    cancelScope,
    cancelSubmitting,
    cancelableEventsForScope,
    closeCancelTransaction,
    hasSharedCancellation,
    submitCancelTransaction,
  } = controller;
  return (
      <BusinessActionModal
        title={cancelInstallmentTarget ? `取消 · ${cancelInstallmentTarget.inst_no}` : cancelOrderTarget ? `取消 · ${cancelOrderTarget.order_no}` : "取消"}
        fieldCount={6}
        open={Boolean(cancelInstallmentTarget || (cancelOrderTarget && !hasSharedCancellation))}
        confirmLoading={cancelSubmitting}
        onCancel={closeCancelTransaction}
        okText="确认取消"
        okButtonProps={{ danger: true }}
        onOk={() => void cancelForm.submit()}
      >
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope={cancelInstallmentTarget ? "INVCANCEL" : cancelScope} form={cancelForm} onFinish={submitCancelTransaction}>
          <FieldConfigScope scope={cancelInstallmentTarget ? "INVCANCEL" : cancelScope} active={Boolean(cancelOrderTarget || cancelInstallmentTarget)}>
          <Typography.Paragraph type="secondary">
            {cancelInstallmentTarget
              ? cancelInstallmentTarget.contract_type === "PICKUP_SALE"
                ? "按已收款原资金池退款，提号取消后交易直接结束。"
                : "按已收款原资金池退款，取消后账号回到库存。"
              : cancelScope === "INVREFUND"
                ? "冲销入库流水，金额进入公司钱包；可按原资金池入账，也可做部分冲销。"
                : "冲销售出流水，金额退还客户；可按原资金池退款，也可做部分冲销。"}
          </Typography.Paragraph>
          {cancelOrderTarget && cancelableEventsForScope(cancelOrderTarget, cancelScope).length > 0 ? (
            <div className="order-cancel-meta">
              <CfgItem
                name="offset_event_id"
                label={cancelScope === "INVREFUND" ? "入库流水" : "售出流水"}
                fixedLabel={cancelScope === "INVREFUND" ? "入库流水" : "售出流水"}
                rules={[{ required: true, message: cancelScope === "INVREFUND" ? "请选择入库流水" : "请选择售出流水" }]}
              >
                <Select
                  placeholder={cancelScope === "INVREFUND" ? "请选择入库流水" : "请选择被冲销动作"}
                  options={cancelableEventsForScope(cancelOrderTarget, cancelScope).map(({ event, remaining }) => ({
                    value: event.id,
                    label: `${executionActionLabel(event.event_type, cancelOrderTarget.order_type)} · ${event.event_no} · ¥${money(event.amount)}（剩余可冲 ¥${money(remaining)}）`,
                  }))}
                  onChange={(value: number) => {
                    const target = cancelableEventsForScope(cancelOrderTarget, cancelScope).find((item) => item.event.id === value);
                    if (target) cancelForm.setFieldsValue({
                      [cancelScope === "INVREFUND" ? "refund_amount" : "cancel_amount"]: target.remaining,
                      pool_id: target.event.pool_id ?? cancelPools[0]?.id,
                    });
                  }}
                />
              </CfgItem>
              <CfgItem name={cancelScope === "INVREFUND" ? "refund_amount" : "cancel_amount"} label={cancelScope === "INVREFUND" ? "入账金额" : "退款金额"} rules={requiredMoneyRules(cancelScope === "INVREFUND" ? "入账金额" : "退款金额")} tooltip="留空或填剩余可冲金额为全额冲销；小于剩余金额即为部分冲销">
                <MoneyInput aria-label={cancelScope === "INVREFUND" ? "入账金额" : "退款金额"} placeholder={cancelScope === "INVREFUND" ? "请输入入账金额" : "请输入退款金额"} />
              </CfgItem>
              <CfgItem alwaysActive name="pool_id" label={cancelScope === "INVREFUND" ? "入账账户" : "收款账户"} rules={[{ required: true, message: cancelScope === "INVREFUND" ? "请选择入账账户" : "请选择收款账户" }]}>
                <Select placeholder={cancelScope === "INVREFUND" ? "请选择入账账户" : "请选择收款账户"} options={cancelPools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))} notFoundContent="暂无可用资金账户" />
              </CfgItem>
              <ResponsibleEmployeeSelect name="operator_user_ids" label={cancelScope === "INVREFUND" ? "入账操作人" : "退款操作人"} employees={cancelEmployees} className="order-cancel-employee" />
            </div>
          ) : null}
          <CfgItem name="cancelled_on" label="取消日期" rules={[{ required: true, message: "请输入取消日期" }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
            <DateField />
          </CfgItem>
          <CfgItem name="reason" label="取消原因" rules={[{ required: true, message: "请输入取消原因" }]}>
            <Input.TextArea rows={3} placeholder="请输入退款及取消原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix="order-cancel" />
          </FieldConfigScope>
        </BusinessRegistrationForm>
      </BusinessActionModal>
  );
}

export function EditOrderModal({ controller }: { controller: OrdersPageController }) {
  const {
    editForm,
    editOpen,
    editSubmitting,
    orderHasPostedEvents,
    selectedOrder,
    setEditOpen,
    submitEditOrder,
  } = controller;
  return (
      <BusinessActionModal
        title={selectedOrder ? `编辑订单 · ${selectedOrder.order_no}` : "编辑订单"}
        fieldCount={7}
        open={editOpen}
        confirmLoading={editSubmitting}
        onCancel={() => { if (!editSubmitting) setEditOpen(false); }}
        okText="保存修改"
        onOk={() => void editForm.submit()}
      >
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="ORDEREDIT" form={editForm} onFinish={submitEditOrder}>
          <FieldConfigScope scope="ORDEREDIT" active={editOpen}>
          <Typography.Paragraph type="secondary">
            订单编号、业务类型、账号关联与状态不可编辑；修改成交日期会同步平移本单事件与资金流水日期，并重取返点/提成规则快照。
          </Typography.Paragraph>
          <CfgItem
            name="trade_date"
            label="成交日期"
            rules={[{ required: true, message: "请输入成交日期" }]}
            extra={orderHasPostedEvents ? "该单已有登记事件，改日期将同步平移事件与资金流水日期" : undefined}
            getValueFromEvent={dateValueFromEvent}
            getValueProps={dateValueProps}
          >
            <DateField />
          </CfgItem>
          <CfgItem name="note" label="备注">
            <Input.TextArea rows={2} placeholder="订单备注（选填）" />
          </CfgItem>

          <CustomFieldSection testIdSuffix="order-edit" />
          </FieldConfigScope>
        </BusinessRegistrationForm>
      </BusinessActionModal>
  );
}

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
  const actionKinds: AllocationType[] = ["BUY", "SELL", "OPERATION", "COMPANY"];
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
              ? "按操作分配：买号、售出、运营、公司四项。比例和金额任填其一，填写时不会互相改写；两者都填时须自洽。买号/售出只能给该动作的执行人。"
              : "每行一位员工：比例和金额任填其一，填写时不会互相改写；两者都填时须自洽。纯比例分润时合计须为 100%，用金额时剩余部分默认留在公司。亏损单按金额分润请填负数（如 -300 表示分担 300 亏损）。"}
          </Typography.Paragraph>
          <Form.List name="allocations">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field, index) => {
                  const kind = isAction ? actionKinds[index] : undefined;
                  // 公司位不绑人；本单没有的动作位（如代挂无买号）也不给填。
                  const company = kind === "COMPANY";
                  const actionMissing = (kind === "BUY" || kind === "SELL") && !hasPosted(kind);
                  // 按操作四项的人员一律锁定为台账登记的执行人：分润只分钱、不编人。
                  // 人员编辑入口只在账号台账与库存中心，避免两处口径打架。
                  const employeeDisabled = isAction || company || actionMissing;
                  return (
                    <AdaptiveFormGrid key={field.key} className={`orders-allocation-row${isAction ? " is-action" : ""}`}>
                      <Form.Item name={[field.name, "allocation_type"]} hidden>
                        <Input />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "employee"]}
                        label={kind ? ALLOCATION_TYPE_LABEL[kind] : "姓名"}
                        rules={employeeDisabled ? [] : [{ required: true, message: "请选择姓名" }]}
                      >
                        <Select
                          placeholder={actionMissing ? "本单无此动作" : "选择员工"}
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
                      <Form.Item
                        name={[field.name, "allocation_rate"]}
                        label="比例"
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
                        />
                      </Form.Item>
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

export function RefundModal({ controller }: { controller: OrdersPageController }) {
  const {
    actionOrder,
    cancelPools,
    currentOperator,
    load,
    refundForm,
    refundOpen,
    refundSubmitting,
    setActionOrder,
    setRefundOpen,
    setRefundSubmitting,
    users,
  } = controller;
  return (
      <BusinessActionModal
        title={actionOrder ? `资金收支 · ${actionOrder.order_no}` : "资金收支"}
        fieldCount={5}
        open={refundOpen}
        confirmLoading={refundSubmitting}
        onCancel={() => { setRefundOpen(false); setActionOrder(null); }}
        onOk={() => void refundForm.submit()}
      >
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="REFUND"
          form={refundForm}
          onFinish={async (values: { amount: string; occurred_on?: Dayjs; direction?: string; pool_id?: number; operator_user_ids?: number[]; reason: string; form_extra?: Record<string, unknown> }) => {
            if (!actionOrder) return;
            setRefundSubmitting(true);
            try {
              // 每笔收支都要指认资金账户：显式选择优先于订单类型的默认路由（规则见 helpers）。
              await ordersApi.postEvent(actionOrder.id, buildRefundEventPayload({ values, fallbackDate: today() }));
              appMessage.success("退款已登记");
              setRefundOpen(false);
              setActionOrder(null);
              await load();
            } catch (error) {
              appMessage.error(normalizeError(error).message);
            } finally {
              setRefundSubmitting(false);
            }
          }}
        >
          <FieldConfigScope scope="REFUND" active={refundOpen}>
          <CfgItem name="occurred_on" label="发生日期" initialValue={dayjs(today())} rules={[{ required: true, message: "请选择发生日期" }]}>
            <DatePicker format="YYYY-MM-DD" className="ui-control-full" />
          </CfgItem>
          <CfgItem name="direction" label="资金流向" initialValue="OUT" rules={[{ required: true, message: "请选择资金流向" }]}>
            <Select disabled options={[{ value: "OUT", label: "支出" }]} />
          </CfgItem>
          <ResponsibleEmployeeSelect name="operator_user_ids" label="操作人" employees={users} />
          <CfgItem name="amount" label="金额" rules={requiredMoneyRules("金额")}>
            <MoneyInput placeholder="请输入退款金额" />
          </CfgItem>
          <CfgItem name="pool_id" label="资金账户" rules={[{ required: true, message: "请选择资金账户" }]}>
            <Select
              aria-label="资金账户"
              placeholder="请选择这笔收支的资金账户"
              options={cancelPools.map((pool) => ({ value: pool.id, label: `${pool.name}（${pool.code}）` }))}
              notFoundContent="暂无可用资金账户"
            />
          </CfgItem>
          <CfgItem name="reason" label="收支备注" rules={[{ required: true, message: "请输入收支备注" }]}>
            <Input.TextArea rows={3} placeholder="请输入收支备注" />
          </CfgItem>
            <CustomFieldSection testIdSuffix="order-refund" />
          </FieldConfigScope>
        </BusinessRegistrationForm>
        <div className="ui-form-spaced orders-event-list">
          <Typography.Text strong>资金明细</Typography.Text>
          {actionOrder?.cashflows?.length ? (
            <div className="orders-event-table" role="table" aria-label="资金明细表">
              <div className="orders-event-row orders-event-row--header" role="row">
                <span role="columnheader">发生日期</span>
                <span role="columnheader">收支</span>
                <span role="columnheader">金额</span>
                <span role="columnheader">操作人</span>
              </div>
              {actionOrder.cashflows.map((flow) => (
                <div key={flow.flow_no} className="orders-event-row" role="row">
                  <span role="cell">{flow.occurred_on}</span>
                  <span role="cell">{flow.direction === "IN" ? "收入" : "支出"} · {flow.category}</span>
                  <span role="cell"><MoneyText value={flow.amount} /></span>
                  <span role="cell">{flow.operator || currentOperator}</span>
                </div>
              ))}
            </div>
          ) : <Typography.Text type="secondary">暂无资金明细</Typography.Text>}
        </div>
      </BusinessActionModal>
  );
}

export function CreateBusinessModalWrapper({ controller }: { controller: OrdersPageController }) {
  const {
    createType,
    load,
    setCreateType,
    setInstallmentRefreshKey,
    setInventoryRefreshKey,
  } = controller;
  return (
      <CreateBusinessModal
        open={Boolean(createType)}
        onClose={() => setCreateType(undefined)}
        onCreated={async () => {
          setCreateType(undefined);
          setInventoryRefreshKey((key) => key + 1);
          // 建单后同步重拉「分期回款」列表，覆盖售出分期等会生成新合约的场景。
          setInstallmentRefreshKey((key) => key + 1);
          await load();
        }}
        initialOrderType={createType ?? "HS"}
      />
  );
}

export function OrderModals({ controller }: { controller: OrdersPageController }) {
  return (
    <>
      <SharedCancellationDialog controller={controller} />
      <CancelTransactionModal controller={controller} />
      <EditOrderModal controller={controller} />
      <AllocationModal controller={controller} />
      <RefundModal controller={controller} />
      <CreateBusinessModalWrapper controller={controller} />
    </>
  );
}
