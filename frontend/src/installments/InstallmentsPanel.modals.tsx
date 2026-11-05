import { Input, Typography } from "antd";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "../orders/ConfigurableField";
import { BusinessActionModal, BusinessRegistrationForm, DateField, InlineError, MoneyInput, PermissionButton, Select, dateValueFromEvent, dateValueProps } from "../shared/ui";
import { requiredMoneyRules } from "../shared/lib/validators";
import type { ContractTableController } from "./useContractTableController";

const Modal = BusinessActionModal;

export function PayModal({ controller }: { controller: ContractTableController }) {
  const {
    payForm,
    payTarget,
    schedules,
    setPayTarget,
    submitPay,
    write,
  } = controller;
  return (
      <Modal
        title={payTarget ? `分期收款 · ${payTarget.inst_no}` : "分期收款"}
        open={Boolean(payTarget)}
        onCancel={() => setPayTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTPAY" active={Boolean(payTarget)}>
          <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INSTPAY" form={payForm} onFinish={submitPay}>
          <CfgItem name="period_no" label="期次（0=首付，留空按到期顺序）">
            <Select
              allowClear
              options={(schedules[payTarget?.id ?? 0] ?? []).map((schedule) => ({
                value: schedule.period_no,
                label: schedule.period_no === 0 ? "首付" : `第 ${schedule.period_no} 期`,
              }))}
            />
          </CfgItem>
          <CfgItem name="amount" label="本次实收" rules={requiredMoneyRules("本次实收")}>
            <MoneyInput />
          </CfgItem>
          <CfgItem name="paid_on" label="收款日期" rules={[{ required: true }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
            <DateField />
          </CfgItem>
          <CustomFieldSection testIdSuffix="installment-pay" />
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit" loading={write.pending}>
            确认收款
          </PermissionButton>
        </BusinessRegistrationForm>
        </FieldConfigScope>
      </Modal>
  );
}

export function RecoverModal({ controller }: { controller: ContractTableController }) {
  const {
    recoverForm,
    recoverTarget,
    setRecoverTarget,
    submitRecover,
    write,
  } = controller;
  return (
      <Modal
        title={recoverTarget ? `逾期回收 · ${recoverTarget.inst_no}` : "逾期回收"}
        open={Boolean(recoverTarget)}
        onCancel={() => setRecoverTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTRECOVER" active={Boolean(recoverTarget)}>
          <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INSTRECOVER" form={recoverForm} onFinish={submitRecover}>
          <CfgItem name="occurred_on" label="回收日期" rules={[{ required: true }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
            <DateField />
          </CfgItem>
          <CfgItem name="note" label="回收说明" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </CfgItem>
          <CustomFieldSection testIdSuffix="installment-recover" />
          <PermissionButton permission="order.update" type="primary" htmlType="submit" loading={write.pending}>
            确认回收
          </PermissionButton>
        </BusinessRegistrationForm>
        </FieldConfigScope>
      </Modal>
  );
}

export function ResaleModal({ controller }: { controller: ContractTableController }) {
  const {
    orders,
    resaleForm,
    resaleTarget,
    setResaleTarget,
    submitResale,
    write,
  } = controller;
  return (
      <Modal
        title={resaleTarget ? `登记出售 · ${resaleTarget.inst_no}` : "登记出售"}
        open={Boolean(resaleTarget)}
        onCancel={() => setResaleTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTRESALE" active={Boolean(resaleTarget)}>
          <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INSTRESALE" form={resaleForm} onFinish={submitResale}>
          <Typography.Paragraph type="secondary">
            回收账号转售登记：请先在库存中心售出该账号生成售出订单，再在此关联。
            出售订单必须已登记 SELL 事件且关联同一账号，每个合约只能登记一次。
          </Typography.Paragraph>
          <CfgItem name="resale_order_id" label="出售订单" rules={[{ required: true, message: "请选择出售订单" }]}>
            <Select
              showSearch
              placeholder="请选择售出订单"
              optionFilterProp="label"
              options={orders
                .filter((item) => item.id !== resaleTarget?.order_id)
                .map((item) => ({
                  value: item.id,
                  label: `${item.order_no}${item.party_name ? ` · ${item.party_name}` : ""}`,
                }))}
            />
          </CfgItem>
          <CfgItem name="occurred_on" label="出售日期" rules={[{ required: true }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
            <DateField />
          </CfgItem>
          <CfgItem name="note" label="出售说明" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </CfgItem>
          <CustomFieldSection testIdSuffix="installment-resale" />
          <PermissionButton permission="order.update" type="primary" htmlType="submit" loading={write.pending}>
            确认登记
          </PermissionButton>
        </BusinessRegistrationForm>
        </FieldConfigScope>
      </Modal>
  );
}

export function DeliverModal({ controller }: { controller: ContractTableController }) {
  const {
    deliverForm,
    deliverTarget,
    setDeliverTarget,
    submitDeliver,
    write,
  } = controller;
  return (
      <Modal
        title={deliverTarget ? `换绑交付 · ${deliverTarget.inst_no}` : "换绑交付"}
        open={Boolean(deliverTarget)}
        onCancel={() => setDeliverTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTDELIVER" active={Boolean(deliverTarget)}>
          <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INSTDELIVER" form={deliverForm} onFinish={submitDeliver}>
          <CfgItem name="delivery_mode" label="交付方式" rules={[{ required: true }]}>
            <Select />
          </CfgItem>
          <CfgItem name="bound_phone" label="换绑手机号">
            <Input placeholder="可选填，默认带出建单信息" />
          </CfgItem>
          <CfgItem name="bound_phone_owner" label="手机号绑定人">
            <Input placeholder="可选填，默认带出建单信息" />
          </CfgItem>
          <CfgItem name="delivered_on" label="换绑日期" rules={[{ required: true }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
            <DateField />
          </CfgItem>
          <CfgItem name="note" label="换绑凭证" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </CfgItem>
          <CustomFieldSection section="DELIVER" testIdSuffix="installment-deliver" />
          <CustomFieldSection testIdSuffix="installment-deliver-extra" />
          <Typography.Paragraph type="secondary">
            仅已结清合约可交付；DELIVER 无金额、不生成现金流，不再确认收入。
          </Typography.Paragraph>
          <PermissionButton permission="order.event.post" type="primary" htmlType="submit" loading={write.pending}>
            确认交付
          </PermissionButton>
        </BusinessRegistrationForm>
        </FieldConfigScope>
      </Modal>
  );
}

export function CancelModal({ controller }: { controller: ContractTableController }) {
  const {
    cancelForm,
    cancelTarget,
    setCancelTarget,
    submitCancel,
    write,
  } = controller;
  return (
      <Modal
        title={cancelTarget ? `退款登记 · ${cancelTarget.inst_no}` : "退款登记"}
        open={Boolean(cancelTarget)}
        onCancel={() => setCancelTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTCANCEL" active={Boolean(cancelTarget)}>
          <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INSTCANCEL" form={cancelForm} onFinish={submitCancel}>
          <Typography.Paragraph type="secondary">
            {cancelTarget?.contract_type === "PICKUP_SALE"
              ? "按已收款原资金池退款，提号取消后账号直接结束。"
              : "按已收款原资金池退款，取消后账号回到库存。"}
          </Typography.Paragraph>
          <CfgItem name="cancelled_on" label="取消日期" rules={[{ required: true }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
            <DateField />
          </CfgItem>
          <CfgItem name="reason" label="取消原因" rules={[{ required: true }]}>
            <Input.TextArea rows={3} placeholder="请输入退款及取消原因" />
          </CfgItem>
          <CustomFieldSection testIdSuffix="installment-cancel" />
          <PermissionButton permission="order.event.post" type="primary" danger htmlType="submit" loading={write.pending}>
            确认退款并终止分期
          </PermissionButton>
        </BusinessRegistrationForm>
        </FieldConfigScope>
      </Modal>
  );
}

export function SettleModal({ controller }: { controller: ContractTableController }) {
  const {
    setSettleTarget,
    settleForm,
    settlePermission,
    settleTarget,
    submitSettleEarly,
    write,
  } = controller;
  return (
      <Modal
        title={settleTarget ? `提前结清 · ${settleTarget.inst_no}` : "提前结清"}
        open={Boolean(settleTarget)}
        onCancel={() => setSettleTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTSETTLE" active={Boolean(settleTarget)}>
          <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INSTSETTLE" form={settleForm} onFinish={submitSettleEarly}>
          <Typography.Paragraph type="secondary">
            一次性收清全部剩余应收，逐期生成收款并关闭未来期次；不指定资金池时按原收款资金池入账。
          </Typography.Paragraph>
          <CfgItem name="paid_on" label="结清日期" rules={[{ required: true, message: "请选择结清日期" }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
            <DateField />
          </CfgItem>
          <CfgItem name="note" label="备注">
            <Input.TextArea rows={2} placeholder="可选" />
          </CfgItem>
          <CustomFieldSection testIdSuffix="installment-settle" />
          <PermissionButton permission={settlePermission} type="primary" htmlType="submit" loading={write.pending}>
            确认提前结清
          </PermissionButton>
        </BusinessRegistrationForm>
        </FieldConfigScope>
      </Modal>
  );
}

export function DefaultModal({ controller }: { controller: ContractTableController }) {
  const {
    defaultForm,
    defaultTarget,
    setDefaultTarget,
    submitDefault,
    write,
  } = controller;
  return (
      <Modal
        title={defaultTarget ? `登记违约 · ${defaultTarget.inst_no}` : "登记违约"}
        open={Boolean(defaultTarget)}
        onCancel={() => setDefaultTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTDEFAULT" active={Boolean(defaultTarget)}>
          <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INSTDEFAULT" form={defaultForm} onFinish={submitDefault}>
          <Typography.Paragraph type="secondary">
            登记后合约进入 DEFAULTED，仅可继续收款或关闭，不可再交付。
          </Typography.Paragraph>
          <CfgItem name="reason" label="违约原因" rules={[{ required: true, message: "请填写违约原因" }]}>
            <Input.TextArea rows={3} />
          </CfgItem>
          <CustomFieldSection testIdSuffix="installment-default" />
          <PermissionButton permission="order.update" type="primary" danger htmlType="submit" loading={write.pending}>
            确认登记违约
          </PermissionButton>
        </BusinessRegistrationForm>
        </FieldConfigScope>
      </Modal>
  );
}

export function WaiveModal({ controller }: { controller: ContractTableController }) {
  const {
    setWaiveTarget,
    submitWaive,
    waiveForm,
    waiveTarget,
    write,
  } = controller;
  return (
      <Modal
        title={waiveTarget ? `期次减免 · 第 ${waiveTarget.period_no} 期` : "期次减免"}
        open={Boolean(waiveTarget)}
        onCancel={() => setWaiveTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTWAIVE" active={Boolean(waiveTarget)}>
          <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INSTWAIVE" form={waiveForm} onFinish={submitWaive}>
          <Typography.Paragraph type="secondary">
            已收款部分不可减免，减免额不得超过该期未收金额；减免后该期不再计入催收。
          </Typography.Paragraph>
          <CfgItem name="amount" label="减免金额" rules={requiredMoneyRules("减免金额")}>
            <MoneyInput />
          </CfgItem>
          <CfgItem name="waived_on" label="减免日期" rules={[{ required: true, message: "请选择减免日期" }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
            <DateField />
          </CfgItem>
          <CfgItem name="reason" label="减免原因" rules={[{ required: true, message: "请填写减免原因" }]}>
            <Input.TextArea rows={2} />
          </CfgItem>
          <CustomFieldSection testIdSuffix="installment-waive" />
          <PermissionButton permission="order.update" type="primary" htmlType="submit" loading={write.pending}>
            确认减免
          </PermissionButton>
        </BusinessRegistrationForm>
        </FieldConfigScope>
      </Modal>
  );
}

export function ExtendModal({ controller }: { controller: ContractTableController }) {
  const {
    extendForm,
    extendTarget,
    setExtendTarget,
    submitExtend,
    write,
  } = controller;
  return (
      <Modal
        title={extendTarget ? `期次展期 · 第 ${extendTarget.period_no} 期（原到期 ${extendTarget.due_on}）` : "期次展期"}
        open={Boolean(extendTarget)}
        onCancel={() => setExtendTarget(null)}
        footer={null}
      >
        <InlineError error={write.error} />
        <FieldConfigScope scope="INSTEXTEND" active={Boolean(extendTarget)}>
          <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope="INSTEXTEND" form={extendForm} onFinish={submitExtend}>
          <Typography.Paragraph type="secondary">
            新到期日必须晚于原到期日；逾期期次展期后回到 PENDING。
          </Typography.Paragraph>
          <CfgItem name="new_due_on" label="新到期日" rules={[{ required: true, message: "请选择新到期日" }]} getValueFromEvent={dateValueFromEvent} getValueProps={dateValueProps}>
            <DateField />
          </CfgItem>
          <CfgItem name="reason" label="展期原因" rules={[{ required: true, message: "请填写展期原因" }]}>
            <Input.TextArea rows={2} />
          </CfgItem>
          <CustomFieldSection testIdSuffix="installment-extend" />
          <PermissionButton permission="order.update" type="primary" htmlType="submit" loading={write.pending}>
            确认展期
          </PermissionButton>
        </BusinessRegistrationForm>
        </FieldConfigScope>
      </Modal>
  );
}

export function ContractModals({ controller }: { controller: ContractTableController }) {
  return (
    <>
      <PayModal controller={controller} />
      <RecoverModal controller={controller} />
      <ResaleModal controller={controller} />
      <DeliverModal controller={controller} />
      <CancelModal controller={controller} />
      <SettleModal controller={controller} />
      <DefaultModal controller={controller} />
      <WaiveModal controller={controller} />
      <ExtendModal controller={controller} />
    </>
  );
}
