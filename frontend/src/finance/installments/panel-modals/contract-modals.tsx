import { Input, Typography } from "antd";
import { CfgItem } from "../../../business/ConfigurableField";
import { DateField, Select, dateValueFromEvent, dateValueProps } from "../../../shared/ui";
import { cancelRefundIntro } from "../../../shared/lib/cancellationCopy";
import type { ContractTableController } from "../useContractTableController";
import { InstallmentActionModal } from "./_shared";

export function RecoverModal({ controller }: { controller: ContractTableController }) {
  const { employees, recoverForm, recoverTarget, setRecoverTarget, submitRecover, write } = controller;
  return (
    <InstallmentActionModal
      title={recoverTarget ? `逾期回收 · ${recoverTarget.inst_no}` : "逾期回收"}
      open={Boolean(recoverTarget)}
      onCancel={() => setRecoverTarget(null)}
      scope="INSTRECOVER"
      form={recoverForm}
      onFinish={submitRecover}
      write={write}
      permission="order.update"
      submitLabel="确认回收"
      employees={employees}
      testIdSuffix="installment-recover"
    >
      <CfgItem
        name="occurred_on"
        label="回收日期"
        rules={[{ required: true }]}
        getValueFromEvent={dateValueFromEvent}
        getValueProps={dateValueProps}
      >
        <DateField />
      </CfgItem>
      <CfgItem name="note" label="回收说明" rules={[{ required: true }]}>
        <Input.TextArea rows={2} />
      </CfgItem>
    </InstallmentActionModal>
  );
}

export function ResaleModal({ controller }: { controller: ContractTableController }) {
  const { employees, resaleOrders, resaleForm, resaleTarget, setResaleTarget, submitResale, write } = controller;
  return (
    <InstallmentActionModal
      title={resaleTarget ? `登记出售 · ${resaleTarget.inst_no}` : "登记出售"}
      open={Boolean(resaleTarget)}
      onCancel={() => setResaleTarget(null)}
      scope="INSTRESALE"
      form={resaleForm}
      onFinish={submitResale}
      write={write}
      permission="order.update"
      submitLabel="确认登记"
      employees={employees}
      intro={
        <Typography.Paragraph type="secondary">
          回收账号转售登记：请先在库存中心售出该账号生成售出订单，再在此关联。
          出售订单必须已登记 SELL 事件且关联同一账号，每个合约只能登记一次。
        </Typography.Paragraph>
      }
      testIdSuffix="installment-resale"
    >
      <CfgItem
        name="resale_order_id"
        label="出售订单"
        rules={[{ required: true, message: "请选择出售订单" }]}
      >
        <Select
          showSearch
          placeholder="请选择售出订单"
          virtual={resaleOrders.length > 100}
          popupMatchSelectWidth={resaleOrders.length > 100}
          optionFilterProp="label"
          options={resaleOrders
            .filter((item) => item.id !== resaleTarget?.order_id)
            .map((item) => ({
              value: item.id,
              label: `${item.order_no}${item.party_name ? ` · ${item.party_name}` : ""}`,
            }))}
        />
      </CfgItem>
      <CfgItem
        name="occurred_on"
        label="出售日期"
        rules={[{ required: true }]}
        getValueFromEvent={dateValueFromEvent}
        getValueProps={dateValueProps}
      >
        <DateField />
      </CfgItem>
      <CfgItem name="note" label="出售说明" rules={[{ required: true }]}>
        <Input.TextArea rows={2} />
      </CfgItem>
    </InstallmentActionModal>
  );
}

export function DeliverModal({ controller }: { controller: ContractTableController }) {
  const { deliverForm, deliverTarget, employees, setDeliverTarget, submitDeliver, write } = controller;
  return (
    <InstallmentActionModal
      title={deliverTarget ? `换绑交付 · ${deliverTarget.inst_no}` : "换绑交付"}
      open={Boolean(deliverTarget)}
      onCancel={() => setDeliverTarget(null)}
      scope="INSTDELIVER"
      form={deliverForm}
      onFinish={submitDeliver}
      write={write}
      permission="order.event.post"
      submitLabel="确认交付"
      employees={employees}
      testIdSuffix="installment-deliver-extra"
      outro={
        <Typography.Paragraph type="secondary">
          仅已结清合约可交付；DELIVER 无金额、不生成现金流，不再确认收入。
        </Typography.Paragraph>
      }
    >
      <CfgItem name="bound_phone" label="换绑手机号">
        <Input placeholder="可选填，默认带出建单信息" />
      </CfgItem>
      <CfgItem name="bound_phone_owner" label="手机号绑定人">
        <Input placeholder="可选填，默认带出建单信息" />
      </CfgItem>
      <CfgItem
        name="delivered_on"
        label="换绑日期"
        rules={[{ required: true }]}
        getValueFromEvent={dateValueFromEvent}
        getValueProps={dateValueProps}
      >
        <DateField />
      </CfgItem>
      <CfgItem name="note" label="换绑凭证" rules={[{ required: true }]}>
        <Input.TextArea rows={2} />
      </CfgItem>
    </InstallmentActionModal>
  );
}

export function CancelModal({ controller }: { controller: ContractTableController }) {
  const { cancelForm, cancelTarget, employees, setCancelTarget, submitCancel, write } = controller;
  return (
    <InstallmentActionModal
      title={cancelTarget ? `退款登记 · ${cancelTarget.inst_no}` : "退款登记"}
      open={Boolean(cancelTarget)}
      onCancel={() => setCancelTarget(null)}
      scope="INSTCANCEL"
      form={cancelForm}
      onFinish={submitCancel}
      write={write}
      permission="order.event.post"
      danger
      submitLabel="确认退款并终止分期"
      employees={employees}
      intro={
        <Typography.Paragraph type="secondary">
          {cancelRefundIntro(cancelTarget?.contract_type)}
        </Typography.Paragraph>
      }
      testIdSuffix="installment-cancel"
    >
      <CfgItem
        name="cancelled_on"
        label="取消日期"
        rules={[{ required: true }]}
        getValueFromEvent={dateValueFromEvent}
        getValueProps={dateValueProps}
      >
        <DateField />
      </CfgItem>
      <CfgItem name="reason" label="取消原因" rules={[{ required: true }]}>
        <Input.TextArea rows={3} placeholder="请输入退款及取消原因" />
      </CfgItem>
    </InstallmentActionModal>
  );
}

export function DefaultModal({ controller }: { controller: ContractTableController }) {
  const { defaultForm, defaultTarget, employees, setDefaultTarget, submitDefault, write } = controller;
  return (
    <InstallmentActionModal
      title={defaultTarget ? `登记违约 · ${defaultTarget.inst_no}` : "登记违约"}
      open={Boolean(defaultTarget)}
      onCancel={() => setDefaultTarget(null)}
      scope="INSTDEFAULT"
      form={defaultForm}
      onFinish={submitDefault}
      write={write}
      permission="order.update"
      danger
      submitLabel="确认登记违约"
      employees={employees}
      intro={
        <Typography.Paragraph type="secondary">
          登记后合约进入 DEFAULTED，仅可继续收款或关闭，不可再交付。
        </Typography.Paragraph>
      }
      testIdSuffix="installment-default"
    >
      <CfgItem name="reason" label="违约原因" rules={[{ required: true, message: "请填写违约原因" }]}>
        <Input.TextArea rows={3} />
      </CfgItem>
    </InstallmentActionModal>
  );
}
