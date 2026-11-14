import { appMessage } from "../../shared/ui/appFeedback";
/** 库存账号售出：回收 / 提号 / 代挂账号从库存中心售出，按货源类型映射订单类型与买家角色。 */
import { Form } from "antd";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { customersApi } from "../../shared/api/customers.api";
import { ordersApi } from "../../shared/api/orders.api";
import { employeesApi } from "../../shared/api/org.api";
import { poolsApi } from "../../shared/api/pools.api";
import type { Account } from "../../shared/api/types/accounts";
import type { Customer } from "../../shared/api/types/customers";
import type { Pool } from "../../shared/api/types/finance";
import type { EmployeeOption } from "../../shared/api/types/org";
import { normalizeError } from "../../shared/api/client";
import { today } from "../../shared/lib/format";
import { BusinessActionModal, BusinessRegistrationForm, ErrorBanner, PermissionButton } from "../../shared/ui";
import { CustomFieldSection, FieldConfigScope } from "../../orders/ConfigurableField";
import { resizeInstallmentSchedule } from "../../orders/InstallmentScheduleFields";
import { RecoveryCustomerSection } from "../../orders/recovery/RecoveryCustomerSection";
import { DeliveryInfoSection } from "../../orders/DeliveryInfoSection";
import { InventoryAccountSummary } from "../InventoryAccountSummary";
import { collectFullPayment, collectInstallmentPayment } from "./receiver";
import { perPeriodServiceFee, saleInstallmentPlan } from "./sale-plan";
import { SaleFinanceCard } from "./SaleFinanceCard";
import "./sale-modal.css";

type SaleInventoryType = "RECOVERY" | "PICKUP" | "CONSIGNMENT" | (string & {});

/** 三类售出各自独立的表单作用域：改一份的字段/必填/板块标题不影响另外两份。 */
const SALE_SCOPE_BY_INVENTORY_TYPE: Record<string, string> = {
  RECOVERY: "SALEREC",
  PICKUP: "SALETH",
  CONSIGNMENT: "SALEDG",
};

/** 买家角色：代挂（CONSIGNMENT）为委托方 CONSIGNOR，其余（回收/提号）为买家 BUYER。 */
function buyerRoleOf(inventoryType: string | null | undefined): "BUYER" | "CONSIGNOR" {
  return inventoryType === "CONSIGNMENT" ? "CONSIGNOR" : "BUYER";
}

export interface InventorySaleModalProps {
  account: Account | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
  /** 固定货源类型（RECOVERY/PICKUP/CONSIGNMENT），由三个业务入口显式注入。 */
  inventoryType: SaleInventoryType;
  /** 弹窗标题，按货源类型差异化。 */
  title?: string;
  /** 买家信息区标题，按货源类型差异化（代挂为委托方信息）。 */
  buyerInfoTitle?: string;
}

type SaleWrapperProps = Pick<InventorySaleModalProps, "account" | "onClose" | "onCreated">;

/**
 * 库存售出表单的共享实现。回收 / 提号 / 代挂三种货源共用同一套字段、校验与提交逻辑，
 * 仅通过 inventoryType 注入的标题、买家信息标题与买家角色产生差异。
 */
export function InventorySaleModalBase(props: InventorySaleModalProps) {
  const { account, inventoryType, title = "售出账号", buyerInfoTitle = "买家信息" } = props;
  const resolvedType = inventoryType;
  const isConsignment = resolvedType === "CONSIGNMENT";
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const open = Boolean(props.account);
  const saleScope = SALE_SCOPE_BY_INVENTORY_TYPE[resolvedType ?? ""];
  const paymentMethod = Form.useWatch("payment_method", form) ?? "FULL";
  const saleAmount = Form.useWatch("amount", form);
  const downPayment = Form.useWatch("down_payment", form);
  const serviceFee = Form.useWatch("service_fee", form);
  const periodServiceFee = Form.useWatch("per_period_service_fee", form);
  const perPeriod = Form.useWatch("per_period", form);
  const periods = Form.useWatch("periods", form);
  const lastAutoPeriodFee = useRef<number | undefined>();
  const lastAutoPeriodAmount = useRef<number | undefined>();

  useEffect(() => {
    const nextValue = perPeriodServiceFee(serviceFee, periods);
    if (nextValue === null) return;
    const isAutoValue = periodServiceFee === undefined || periodServiceFee === lastAutoPeriodFee.current;
    if (isAutoValue) {
      form.setFieldValue("per_period_service_fee", nextValue);
      lastAutoPeriodFee.current = nextValue;
    }
  }, [form, periodServiceFee, periods, serviceFee]);

  // 分期金额规划的唯一算法来源（见 sale-plan.ts）：自动填值、末期提示、校验共用一套「分」。
  const plan = useMemo(
    () => saleInstallmentPlan({ saleAmount, downPayment, serviceFee, periods }),
    [downPayment, periods, saleAmount, serviceFee],
  );

  useEffect(() => {
    if (!plan) return;
    const nextValue = plan.perPeriodCents / 100;
    const isAutoValue = perPeriod === undefined || perPeriod === lastAutoPeriodAmount.current;
    if (isAutoValue) {
      form.setFieldValue("per_period", nextValue);
      lastAutoPeriodAmount.current = nextValue;
    }
  }, [form, perPeriod, plan]);

  useEffect(() => {
    if (paymentMethod !== "INSTALLMENT") return;
    const count = Number(periods);
    if (!Number.isInteger(count) || count <= 0) return;
    const current = form.getFieldValue("installment_schedule") as Array<{ due_on?: unknown }> | undefined;
    const next = resizeInstallmentSchedule(current, count, (index) => ({ due_on: dayjs().add(index + 1, "month") })).map((item, index) => ({
      ...item,
      due_on: item.due_on ?? dayjs().add(index + 1, "month"),
    }));
    if (current?.length !== next.length || current.some((item) => !item?.due_on)) form.setFieldValue("installment_schedule", next);
  }, [form, paymentMethod, periods]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([customersApi.list(), poolsApi.list(), employeesApi.list()])
      .then(([customerList, poolList, employeeList]) => {
        if (cancelled) return;
        setCustomers(customerList);
        setPools(poolList.filter((pool) => pool.status === "ACTIVE"));
        setEmployees(employeeList);
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) setError(normalizeError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !props.account) return;
    form.setFieldsValue({ bound_phone: props.account.bound_phone ?? undefined });
  }, [form, open, props.account]);

  const submit = async (values: Record<string, unknown>) => {
    if (!props.account) return;
    const sourceOrderId = props.account.source_order_id;
    if (sourceOrderId == null) {
      setError({ message: "该库存账号未关联到入库订单，无法在其上登记售出" });
      return;
    }
    setSubmitting(true);
    // 售出 = 原买入订单上的卖出动作（SELL），不再新建订单；买家建档后挂到来源单。
    try {
      const customerNickname = String(values.customer_nickname ?? "").trim();
      const customerPhone = values.customer_phone as string | undefined;
      const customerWechat = values.customer_wechat as string | undefined;
      const existingCustomer = customers.find((customer) =>
        customer.display_name === customerNickname
        && ((customerPhone && customer.phone === customerPhone)
          || (customerWechat && customer.wechat === customerWechat)
          || (!customerPhone && !customerWechat)),
      );
      const customer = existingCustomer ?? (await customersApi.create({
        display_name: customerNickname,
        contact_name: values.customer_contact_name as string | undefined,
        phone: customerPhone,
        wechat: customerWechat,
        qq: values.customer_qq as string | undefined,
        source: values.customer_source as string | undefined,
        note: values.note as string | undefined,
      })).customer;
      if (customer.status === "DISABLED" || customer.status === "MERGED") {
        setError({
          message: customer.status === "MERGED"
            ? "客户已合并，不能作为售出买家"
            : "客户已拉黑，不能作为售出买家",
        });
        return;
      }
      await ordersApi.addCustomerRole(sourceOrderId, {
        customer_id: customer.id,
        role: buyerRoleOf(resolvedType),
      });

      if (values.payment_method === "INSTALLMENT") {
        await collectInstallmentPayment({ sourceOrderId, values });
        appMessage.success("分期售出已创建，账号已进入分期中");
      } else {
        await collectFullPayment({ sourceOrderId, values, isConsignment });
        appMessage.success("账号已售出");
      }
      // 售出表单的交付信息是卖号交付的事实来源；统一 merge 到来源订单，详情直接复用这一组字段。
      const deliveryFormExtra: Record<string, unknown> = {};
      for (const key of ["bound_phone", "bound_phone_owner", "intermediary_platform", "intermediary_type", "compensation_type"]) {
        const value = values[key];
        if (value !== undefined && value !== null && value !== "") deliveryFormExtra[key] = value;
      }
      const deliveryResponsibleIds = Array.isArray(values.delivery_responsible_ids)
        ? (values.delivery_responsible_ids as unknown[]).filter((id): id is number => typeof id === "number")
        : [];
      if (deliveryResponsibleIds.length > 0) deliveryFormExtra.delivery_responsible_ids = deliveryResponsibleIds;
      if (Object.keys(deliveryFormExtra).length > 0) {
        await ordersApi.patch(sourceOrderId, { form_extra: deliveryFormExtra });
      }
      form.resetFields();
      props.onClose();
      await props.onCreated();
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BusinessActionModal
      title={title}
      fieldCount={21}
      open={open}
      className="inventory-sale-modal"
      destroyOnHidden
      onCancel={props.onClose}
      footer={
        <PermissionButton permission="order.create" type="primary" loading={submitting} onClick={() => form.submit()}>
          确认售出
        </PermissionButton>
      }
    >
      <ErrorBanner error={error} />
      <InventoryAccountSummary account={props.account} />
      <FieldConfigScope scope={saleScope ?? ""} active={open && Boolean(saleScope)}>
        <BusinessRegistrationForm
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "108px" }}
          wrapperCol={{ flex: "auto" }} scope={saleScope ?? ""} form={form} onFinish={submit}>
          <RecoveryCustomerSection title={buyerInfoTitle} />
          <DeliveryInfoSection showIntermediary employees={employees} />
          <SaleFinanceCard
            isConsignment={isConsignment}
            paymentMethod={paymentMethod}
            saleAmount={saleAmount}
            downPayment={downPayment}
            perPeriod={perPeriod}
            plan={plan}
            pools={pools}
          />
          <CustomFieldSection testIdSuffix="inventory-sale" />
        </BusinessRegistrationForm>
      </FieldConfigScope>
    </BusinessActionModal>
  );
}

/** 回收账号售出（RECOVERY）。 */
export function RecoverySaleModal(props: SaleWrapperProps) {
  return <InventorySaleModalBase {...props} inventoryType="RECOVERY" title="售出回收账号" buyerInfoTitle="买家信息" />;
}

/** 提号账号售出（PICKUP）。 */
export function PickupSaleModal(props: SaleWrapperProps) {
  return <InventorySaleModalBase {...props} inventoryType="PICKUP" title="售出提号账号" buyerInfoTitle="买家信息" />;
}

/** 代挂账号售出（CONSIGNMENT），买家为委托方。 */
export function ConsignmentSaleModal(props: SaleWrapperProps) {
  return <InventorySaleModalBase {...props} inventoryType="CONSIGNMENT" title="售出代挂账号" buyerInfoTitle="委托方信息" />;
}
