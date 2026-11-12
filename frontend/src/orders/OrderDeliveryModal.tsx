import dayjs, { type Dayjs } from "dayjs";
import { DatePicker, Form, Input } from "antd";
import { useEffect } from "react";
import { ordersApi } from "../shared/api/orders.api";
import type { EmployeeOption } from "../shared/api/types/org";
import { normalizeError } from "../shared/api/client";
import { today } from "../shared/lib/format";
import { appMessage } from "../shared/ui/appFeedback";
import { BusinessActionModal, BusinessRegistrationForm, Select } from "../shared/ui";
import { CfgItem, CustomFieldSection, FieldConfigScope } from "./ConfigurableField";
import { ResponsibleEmployeeSelect } from "./ResponsibleEmployeeSelect";

export type OrderDeliveryTarget = {
  orderId: number;
  orderNo: string;
  direction: "BUY" | "SELL";
  boundPhone?: string | null;
  boundPhoneOwner?: string | null;
};

const DIRECTION_OPTIONS = [
  { value: "BUY", label: "买号交付" },
  { value: "SELL", label: "卖号交付" },
];

const DELIVERY_MODE_OPTIONS = [
  { value: "CUSTOMER_SELF", label: "客户自行换绑" },
  { value: "PLATFORM_OPERATOR", label: "平台/本方操作换绑" },
];

export function OrderDeliveryModal({
  target,
  employees,
  onClose,
  onCreated,
}: {
  target: OrderDeliveryTarget | null;
  employees: EmployeeOption[];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [form] = Form.useForm();

  useEffect(() => {
    if (!target) return;
    form.resetFields();
    form.setFieldsValue({
      delivery_direction: target.direction,
      delivery_mode: "CUSTOMER_SELF",
      occurred_on: dayjs(today()),
      bound_phone: target.boundPhone ?? undefined,
      bound_phone_owner: target.boundPhoneOwner ?? undefined,
    });
  }, [form, target]);

  const submit = async (values: {
    delivery_direction: "BUY" | "SELL";
    delivery_mode: string;
    occurred_on?: Dayjs;
    bound_phone?: string;
    bound_phone_owner?: string;
    operator_user_ids?: number[];
    note: string;
    form_extra?: Record<string, unknown>;
  }) => {
    if (!target) return;
    try {
      await ordersApi.postEvent(target.orderId, {
        event_type: "DELIVER",
        delivery_direction: values.delivery_direction,
        delivery_mode: values.delivery_mode,
        occurred_on: (values.occurred_on ?? dayjs(today())).format("YYYY-MM-DD"),
        bound_phone: values.bound_phone?.trim() || undefined,
        bound_phone_owner: values.bound_phone_owner?.trim() || undefined,
        operator_user_ids: values.operator_user_ids,
        note: values.note.trim(),
        form_extra_scope: "DELIVER",
        form_extra: values.form_extra,
      });
      appMessage.success("交付已登记");
      form.resetFields();
      onClose();
      await onCreated();
    } catch (error) {
      appMessage.error(normalizeError(error).message);
    }
  };

  return (
    <BusinessActionModal
      title={target ? `交付 · ${target.orderNo}` : "交付"}
      fieldCount={7}
      open={Boolean(target)}
      okText="确定交付"
      onCancel={onClose}
      onOk={() => void form.submit()}
    >
      <FieldConfigScope scope="DELIVER" active={Boolean(target)}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }}
          scope="DELIVER"
          form={form}
          onFinish={submit}
        >
          <CfgItem name="delivery_direction" label="交付方向" rules={[{ required: true, message: "请选择交付方向" }]}>
            <Select aria-label="交付方向" options={DIRECTION_OPTIONS} />
          </CfgItem>
          <CfgItem name="delivery_mode" label="交付方式" rules={[{ required: true, message: "请选择交付方式" }]}>
            <Select aria-label="交付方式" options={DELIVERY_MODE_OPTIONS} />
          </CfgItem>
          <CfgItem name="occurred_on" label="交付日期" rules={[{ required: true, message: "请选择交付日期" }]}>
            <DatePicker format="YYYY-MM-DD" className="ui-control-full" />
          </CfgItem>
          <CfgItem name="bound_phone" label="换绑手机号">
            <Input placeholder="可选填" />
          </CfgItem>
          <CfgItem name="bound_phone_owner" label="手机号绑定人">
            <Input placeholder="可选填" />
          </CfgItem>
          <ResponsibleEmployeeSelect name="operator_user_ids" label="交付负责人" employees={employees} />
          <CfgItem name="note" label="交付凭证" rules={[{ required: true, whitespace: true, message: "请输入交付凭证" }]}>
            <Input.TextArea aria-label="交付凭证" rows={3} placeholder="请输入换绑或交接凭证说明" />
          </CfgItem>
          <CustomFieldSection section="DELIVER" testIdSuffix="order-delivery" />
        </BusinessRegistrationForm>
      </FieldConfigScope>
    </BusinessActionModal>
  );
}
