import dayjs, { type Dayjs } from "dayjs";
import type { AllocationFormRow } from "./OrdersPage.fragments";
import { Alert, DatePicker, Form, Input, Typography } from "antd";
import { validateAllocations } from "./OrdersPage.fragments";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "./ConfigurableField";
import { CreateBusinessModal } from "./CreateBusinessModal";
import { MoneyInput, MoneyText, PermissionButton, Select, AdaptiveFormGrid, BusinessActionModal, BusinessForm } from "../shared/ui";
import { ResponsibleEmployeeSelect } from "./ResponsibleEmployeeSelect";
import { appMessage } from "../shared/ui/appFeedback";
import { normalizeError } from "../shared/api/client";
import { executionActionLabel, money, today } from "../shared/lib/format";
import { ordersApi, policyApi } from "../shared/api/catalog";
import { requiredMoneyRules, percentRules, moneyRules } from "../shared/lib/validators";
import type { OrdersPageController } from "./useOrdersPageController";

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
    submitCancelTransaction,
  } = controller;
  return (
      <BusinessActionModal
        title={cancelInstallmentTarget ? `分期取消交易 · ${cancelInstallmentTarget.inst_no}` : cancelOrderTarget ? `${cancelScope === "INVREFUND" ? "库存取消交易" : "售出取消交易"} · ${cancelOrderTarget.order_no}` : "取消交易"}
        open={Boolean(cancelOrderTarget || cancelInstallmentTarget)}
        confirmLoading={cancelSubmitting}
        onCancel={closeCancelTransaction}
        okText="确认取消交易"
        okButtonProps={{ danger: true }}
        onOk={() => void cancelForm.submit()}
      >
        <BusinessForm scope={cancelInstallmentTarget ? "INVCANCEL" : cancelScope} form={cancelForm} onFinish={submitCancelTransaction}>
          <FieldConfigScope scope={cancelInstallmentTarget ? "INVCANCEL" : cancelScope} active={Boolean(cancelOrderTarget || cancelInstallmentTarget)}>
          <Typography.Paragraph type="secondary">
            {cancelInstallmentTarget
              ? cancelInstallmentTarget.contract_type === "PICKUP_SALE"
                ? "按已收款原资金池退款，提号取消后交易直接结束。"
                : cancelInstallmentTarget.contract_type === "ADVANCE_PURCHASE"
                  ? "按已收款原资金池退款，取消后终止代分期交易。"
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
                    label: `${executionActionLabel(event.event_type, cancelOrderTarget.order_type)} · ${event.event_no} · ¥${money(event.amount)}（剩余可冲 ¥${money(remaining.toFixed(2))}）`,
                  }))}
                  onChange={(value: number) => {
                    const target = cancelableEventsForScope(cancelOrderTarget, cancelScope).find((item) => item.event.id === value);
                    if (target) cancelForm.setFieldsValue({
                      [cancelScope === "INVREFUND" ? "refund_amount" : "cancel_amount"]: target.remaining.toFixed(2),
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
          <CfgItem name="cancelled_on" label="取消日期" rules={[{ required: true, message: "请输入取消日期" }]}>
            <Input placeholder="YYYY-MM-DD" />
          </CfgItem>
          <CfgItem name="reason" label="取消原因" rules={[{ required: true, message: "请输入取消原因" }]}>
            <Input.TextArea rows={3} placeholder="请输入退款及取消原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix="order-cancel" />
          </FieldConfigScope>
        </BusinessForm>
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
        open={editOpen}
        confirmLoading={editSubmitting}
        onCancel={() => { if (!editSubmitting) setEditOpen(false); }}
        okText="保存修改"
        onOk={() => void editForm.submit()}
      >
        <BusinessForm scope="ORDEREDIT" form={editForm} onFinish={submitEditOrder}>
          <FieldConfigScope scope="ORDEREDIT" active={editOpen}>
          <Typography.Paragraph type="secondary">
            订单编号、业务类型、账号关联与状态不可编辑；已有登记事件的订单只能修改备注，核算字段须通过冲销/更正处理。
          </Typography.Paragraph>
          <CfgItem
            name="trade_date"
            label="成交日期"
            rules={orderHasPostedEvents ? [] : [{ required: true, message: "请输入成交日期" }]}
            extra={orderHasPostedEvents ? "已有登记事件，成交日期不可修改" : undefined}
          >
            <Input placeholder="YYYY-MM-DD" disabled={orderHasPostedEvents} />
          </CfgItem>
          <CfgItem name="note" label="备注">
            <Input.TextArea rows={2} placeholder="订单备注（选填）" />
          </CfgItem>
          {selectedOrder?.account_snapshot && selectedOrder.order_type === "DFQ" && !orderHasPostedEvents ? (
            selectedOrder.account_snapshot.game_password ? (
              <>
                <Typography.Paragraph type="secondary">账号快照（代分期建单时填写的文本信息）：</Typography.Paragraph>
                <CfgItem name="snap_game_account" label="库存编号" rules={[{ required: true, message: "请输入库存编号" }]}>
                  <Input />
                </CfgItem>
                <CfgItem name="snap_game_type" label="游戏/产品类型"><Input /></CfgItem>
                <CfgItem name="snap_game_password" label="账号密码"><Input placeholder="留空表示清除密码" /></CfgItem>
                <CfgItem name="snap_channel_region" label="区服"><Input /></CfgItem>
                <CfgItem name="snap_bound_phone" label="绑定手机"><Input /></CfgItem>
                <CfgItem name="snap_platform" label="平台"><Input /></CfgItem>
                <CfgItem name="snap_purchase_price" label="号价" rules={moneyRules("号价")}><MoneyInput placeholder="例如 1000.00" /></CfgItem>
                <CfgItem name="snap_note" label="快照备注"><Input.TextArea rows={2} /></CfgItem>
              </>
            ) : (
              <Typography.Paragraph type="secondary">账号快照密码字段无权查看，为避免覆盖隐藏信息，快照暂不可编辑；如需修改请联系有订单创建权限的人员。</Typography.Paragraph>
            )
          ) : null}
          <CustomFieldSection testIdSuffix="order-edit" />
          </FieldConfigScope>
        </BusinessForm>
      </BusinessActionModal>
  );
}

export function AllocationModal({ controller }: { controller: OrdersPageController }) {
  const {
    actionOrder,
    allocationForm,
    allocationIsLoss,
    allocationOpen,
    allocationProfit,
    allocationSubmitting,
    employeeOptions,
    profitRoleOptions,
    setActionOrder,
    setAllocationOpen,
    setAllocationSubmitting,
  } = controller;
  return (
      <BusinessActionModal
        title={actionOrder ? `分润 · ${actionOrder.order_no}` : "分润"}
        open={allocationOpen}
        width={720}
        confirmLoading={allocationSubmitting}
        onCancel={() => { setAllocationOpen(false); setActionOrder(null); }}
        onOk={() => void allocationForm.submit()}
      >
        <BusinessForm
          scope="ALLOCATION"
          form={allocationForm}
          layout="vertical"
          onFinish={async (values: { allocations: AllocationFormRow[]; form_extra?: Record<string, unknown> }) => {
            if (!actionOrder) return;
            const rows = (values.allocations ?? []).filter(
              (row) => row.employee !== undefined && row.employee !== null,
            );
            if (rows.length === 0) {
              appMessage.error("请先在员工花名册里选择分润对象");
              return;
            }
            const result = validateAllocations(rows, allocationProfit);
            if (!result.ok) {
              appMessage.error(result.error);
              return;
            }
            const items = result.items;
            setAllocationSubmitting(true);
            try {
              await policyApi.setAllocations(actionOrder.id, items, values.form_extra);
              appMessage.success("分润已保存");
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
                {allocationIsLoss ? "（亏损）金额分润不可用，请按比例或暂不分润" : null}
              </span>
            }
          />
          <Typography.Paragraph type="secondary">
            每行一位员工：填<strong>比例</strong>按订单利润占比分，填<strong>金额</strong>按固定额分，
            两者都选填、同一行只填一个。纯比例分润时合计须为 100%，用金额时剩余部分默认留在公司。
          </Typography.Paragraph>
          <Form.List name="allocations">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <AdaptiveFormGrid key={field.key} className="orders-allocation-row">
                    <Form.Item
                      name={[field.name, "employee"]}
                      label="姓名"
                      rules={[{ required: true, message: "请选择姓名" }]}
                    >
                      <Select
                        placeholder="选择员工"
                        options={employeeOptions}
                        className="ui-control-width-200"
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "role"]}
                      label="角色"
                      initialValue="OWNER"
                    >
                      <Select
                        placeholder="选择角色"
                        options={profitRoleOptions}
                        className="ui-control-width-120"
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "allocation_rate"]}
                      label="比例"
                      rules={percentRules("比例")}
                    >
                      <Input suffix="%" inputMode="decimal" className="ui-control-width-120" />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "allocation_amount"]}
                      label="金额"
                      rules={moneyRules("金额")}
                    >
                      <Input prefix="¥" inputMode="decimal" className="ui-control-width-140" />
                    </Form.Item>
                    <PermissionButton
                      permission="policy.manage"
                      type="link"
                      danger
                      disabled={fields.length <= 1}
                      onClick={() => remove(field.name)}
                    >
                      删除
                    </PermissionButton>
                  </AdaptiveFormGrid>
                ))}
                <PermissionButton
                  permission="policy.manage"
                  type="dashed"
                  block
                  onClick={() => add({ role: "OWNER", allocation_rate: "", allocation_amount: "" })}
                >
                  + 增加一行
                </PermissionButton>
              </>
            )}
          </Form.List>
          <FieldConfigScope scope="ALLOCATION" active={allocationOpen}>
            <CustomFieldSection testIdSuffix="order-allocation" />
          </FieldConfigScope>
        </BusinessForm>
      </BusinessActionModal>
  );
}

export function RefundModal({ controller }: { controller: OrdersPageController }) {
  const {
    actionOrder,
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
        open={refundOpen}
        confirmLoading={refundSubmitting}
        onCancel={() => { setRefundOpen(false); setActionOrder(null); }}
        onOk={() => void refundForm.submit()}
      >
        <BusinessForm scope="REFUND"
          form={refundForm}
          layout="vertical"
          onFinish={async (values: { amount: string; occurred_on?: Dayjs; direction?: string; operator_user_ids?: number[]; reason: string; form_extra?: Record<string, unknown> }) => {
            if (!actionOrder) return;
            setRefundSubmitting(true);
            try {
              await ordersApi.postEvent(actionOrder.id, {
                event_type: "REFUND",
                amount: values.amount,
                occurred_on: values.occurred_on?.format("YYYY-MM-DD") ?? today(),
                reason: values.reason,
                operator_user_ids: values.operator_user_ids,
                form_extra: values.form_extra,
              });
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
          <CfgItem name="reason" label="收支备注" rules={[{ required: true, message: "请输入收支备注" }]}>
            <Input.TextArea rows={3} placeholder="请输入收支备注" />
          </CfgItem>
            <CustomFieldSection testIdSuffix="order-refund" />
          </FieldConfigScope>
        </BusinessForm>
        <div className="ui-form-spaced">
          <Typography.Text strong>资金明细</Typography.Text>
          {actionOrder?.cashflows?.length ? actionOrder.cashflows.map((flow) => (
            <div key={flow.flow_no} className="orders-event-row">
              <span>{flow.occurred_on}</span>
              <span>{flow.direction === "IN" ? "收入" : "支出"} · {flow.category}</span>
              <span><MoneyText value={flow.amount} /></span>
              <span>操作人：{flow.operator || currentOperator}</span>
            </div>
          )) : <Typography.Text type="secondary">暂无资金明细</Typography.Text>}
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
          // 代分期建单会同时生成新分期合约，同步重拉「分期回款」列表。
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
      <CancelTransactionModal controller={controller} />
      <EditOrderModal controller={controller} />
      <AllocationModal controller={controller} />
      <RefundModal controller={controller} />
      <CreateBusinessModalWrapper controller={controller} />
    </>
  );
}
