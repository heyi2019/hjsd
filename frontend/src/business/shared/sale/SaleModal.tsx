import { appMessage } from "../../../shared/ui/appFeedback";
/** 库存账号售出：回收 / 提号 / 代挂账号从库存中心售出，按货源类型映射订单类型与买家角色。 */
import { Form } from "antd";
import dayjs from "dayjs";
import { useEffect, useRef, useState } from "react";
import { employeesApi } from "../../../shared/api/org.api";
import { poolsApi } from "../../../shared/api/pools.api";
import { installmentsApi, type SaleInstallmentPlan } from "../../../shared/api/installments.api";
import type { Account } from "../../../shared/api/types/accounts";
import type { Pool } from "../../../shared/api/types/finance";
import type { EmployeeOption } from "../../../shared/api/types/org";
import { currentDevUser, normalizeError } from "../../../shared/api/client";
import { useSession } from "../../../shared/state/session";
import { BusinessActionModal, BusinessRegistrationForm, ErrorBanner, PermissionButton } from "../../../shared/ui";
import { CustomFieldSections, FieldConfigScope } from "../../../shared/forms/ConfigurableField";
import { resizeInstallmentSchedule } from "../forms/InstallmentScheduleFields";
import { RecoveryCustomerSection } from "../forms/RecoveryCustomerSection";
import { DeliveryInfoSection } from "../forms/DeliveryInfoSection";
import { InventoryAccountSummary } from "../inventory/InventoryAccountSummary";
import { collectFullPayment, collectInstallmentPayment } from "./receiver";
import { SaleFinanceCard } from "./SaleFinanceCard";
import { useAsyncAction } from "../../../shared/hooks/useAsyncAction";
import { useRequestSession } from "../../../shared/hooks/useLatestRequest";
import { useIdempotencyDraft } from "../../../shared/hooks/useIdempotencyDraft";
import { compareMoney } from "../../../shared/lib/money";
import { optionHasBehavior } from "../../../shared/lib/optionSets";
import "./SaleModal.css";

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

interface InventorySaleModalProps {
  account: Account | null;
  onClose: () => void;
  onCreated: (account: Account) => void | Promise<void>;
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
function InventorySaleModalBase(props: InventorySaleModalProps) {
  const { account, inventoryType, title = "售出账号", buyerInfoTitle = "买家信息" } = props;
  const resolvedType = inventoryType;
  const isConsignment = resolvedType === "CONSIGNMENT";
  const [pools, setPools] = useState<Pool[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const write = useAsyncAction();
  const submitting = write.pending;
  const session = useRequestSession(account);
  const idempotency = useIdempotencyDraft();
  const [form] = Form.useForm();
  const { username } = useSession();
  const open = Boolean(props.account);
  const saleScope = SALE_SCOPE_BY_INVENTORY_TYPE[resolvedType ?? ""];
  const paymentMethod = Form.useWatch("payment_method", form) ?? "FULL";
  const saleAmount = Form.useWatch("amount", form);
  const downPayment = Form.useWatch("down_payment", form);
  const serviceFee = Form.useWatch("service_fee", form);
  const periodServiceFee = Form.useWatch("per_period_service_fee", form);
  const perPeriod = Form.useWatch("per_period", form);
  const periods = Form.useWatch("periods", form);
  const lastAutoPeriodFee = useRef<string | undefined>();
  const lastAutoPeriodAmount = useRef<string | undefined>();
  const [plan, setPlan] = useState<SaleInstallmentPlan | null>(null);

  useEffect(() => {
    setPlan(null);
    const count = Number(periods);
    const sale = String(saleAmount ?? "");
    const down = String(downPayment || "0");
    const saleValid = compareMoney(sale, "0");
    const downValid = compareMoney(down, sale);
    const fee = Number(serviceFee ?? 0);
    if (!Number.isInteger(count) || count <= 0 || saleValid === null
      || downValid === null || downValid > 0 || !Number.isFinite(fee) || fee < 0) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void installmentsApi.previewSalePlan({
        sale_amount: String(saleAmount),
        down_payment: String(downPayment ?? 0),
        service_fee: String(serviceFee ?? 0),
        periods: count,
        ...(perPeriod == null || perPeriod === "" ? {} : { per_period: String(perPeriod) }),
      }).then((result) => {
        if (cancelled) return;
        setPlan(result);
        const nextFee = result.per_period_service_fee;
        const isAutoFee = periodServiceFee === undefined || (lastAutoPeriodFee.current !== undefined && compareMoney(String(periodServiceFee), lastAutoPeriodFee.current) === 0);
        if (isAutoFee) {
          form.setFieldValue("per_period_service_fee", nextFee);
          lastAutoPeriodFee.current = nextFee;
        }
        const nextAmount = result.per_period;
        const isAutoAmount = perPeriod === undefined || (lastAutoPeriodAmount.current !== undefined && compareMoney(String(perPeriod), lastAutoPeriodAmount.current) === 0);
        if (isAutoAmount) {
          form.setFieldValue("per_period", nextAmount);
          lastAutoPeriodAmount.current = nextAmount;
        }
      }).catch(() => {
        if (!cancelled) setPlan(null);
      });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [downPayment, form, periodServiceFee, perPeriod, periods, saleAmount, serviceFee]);

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
    void Promise.all([poolsApi.list(), employeesApi.list()])
      .then(([poolList, employeeList]) => {
        if (cancelled) return;
        setPools(poolList.filter((pool) => pool.status === "ACTIVE"));
        setEmployees(employeeList);
      })
      .catch((cause) => {
        if (!cancelled) setError(normalizeError(cause));
      });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open || !props.account) return;
    form.resetFields();
    setError(null);
    lastAutoPeriodFee.current = undefined;
    lastAutoPeriodAmount.current = undefined;
    setPlan(null);
  }, [form, open, props.account?.id, props.account?.source_order_id]);

  useEffect(() => {
    if (!open || !props.account) return;
    form.setFieldsValue({ bound_phone: props.account.bound_phone ?? undefined });
  }, [form, open, props.account?.id, props.account?.bound_phone]);

  const submit = async (values: Record<string, unknown>) => {
    const submittedAccount = props.account;
    if (!submittedAccount) return;
    const customerNickname = String(values.customer_nickname ?? "").trim();
    const sourceOrderId = submittedAccount.source_order_id;
    if (sourceOrderId == null) {
      setError({ message: "该库存账号未关联到入库订单，无法在其上登记售出" });
      return;
    }
    const submittedSession = session.current();
    await write.run(async () => {
      setError(null);
      try {
        const selectedOperatorIds = Array.isArray(values.operator_user_ids)
          ? (values.operator_user_ids as unknown[]).filter((id): id is number => typeof id === "number")
          : [];
        const devUsername = import.meta.env.DEV ? currentDevUser() : undefined;
        let currentEmployeeId = employees.find((employee) => employee.is_active && employee.username === username)?.id
          ?? (devUsername ? employees.find((employee) => employee.is_active && employee.username === devUsername)?.id : undefined);
        // 未选操作人时重新读取人员，避免弹窗刚打开时丢失默认当前人。
        if (selectedOperatorIds.length === 0 && currentEmployeeId === undefined) {
          const latestEmployees = await employeesApi.list();
          currentEmployeeId = latestEmployees.find((employee) => employee.is_active && employee.username === username)?.id
            ?? (devUsername ? latestEmployees.find((employee) => employee.is_active && employee.username === devUsername)?.id : undefined);
        }
        const operatorUserIds = selectedOperatorIds.length > 0
          ? selectedOperatorIds
          : currentEmployeeId === undefined ? [] : [currentEmployeeId];
        if (operatorUserIds.length === 0) {
          setError({ message: "售出操作人必填" });
          return;
        }
        values.operator_user_ids = operatorUserIds;
        const customerInput = customerNickname ? {
          display_name: customerNickname,
          role: buyerRoleOf(resolvedType),
          contact_name: values.customer_contact_name as string | undefined,
          phone: values.customer_phone as string | undefined,
          wechat: values.customer_wechat as string | undefined,
          qq: values.customer_qq as string | undefined,
          source: (optionHasBehavior("CUSTOMER_SOURCE", values.customer_source, "OTHER") ? values.customer_source_other : values.customer_source) as string | undefined,
          note: values.note as string | undefined,
        } : undefined;
        const deliveryFormExtra: Record<string, unknown> = {};
        for (const key of ["bound_phone", "bound_phone_owner", "intermediary_platform", "intermediary_type", "compensation_type"]) {
          const value = values[key];
          if (value !== undefined && value !== null && value !== "") deliveryFormExtra[key] = value;
        }
        if (values.intermediary_platform !== undefined && values.intermediary_platform !== null && values.intermediary_platform !== "") {
          deliveryFormExtra.intermediary_platform_other = optionHasBehavior("INTERMEDIARY_PLATFORM", values.intermediary_platform, "OTHER")
            ? values.intermediary_platform_other || null : null;
        }
        const deliveryResponsibleIds = Array.isArray(values.delivery_responsible_ids)
          ? (values.delivery_responsible_ids as unknown[]).filter((id): id is number => typeof id === "number")
          : [];
        if (deliveryResponsibleIds.length > 0) deliveryFormExtra.delivery_responsible_ids = deliveryResponsibleIds;
        if (values.payment_method === "INSTALLMENT") {
          await collectInstallmentPayment({ sourceOrderId, values, customerInput, deliveryFormExtra, idempotencyKey: idempotency.get(submittedSession).key });
          appMessage.success("分期售出已创建，账号已进入分期中");
        } else {
          await collectFullPayment({ sourceOrderId, values, isConsignment, customerInput, deliveryFormExtra, idempotencyKey: idempotency.get(submittedSession).key });
          appMessage.success("账号已售出");
        }
        if (session.isCurrent(submittedSession)) {
          form.resetFields();
          close();
        }
        void Promise.resolve().then(() => props.onCreated(submittedAccount))
          .catch(() => appMessage.warning("售出已保存，但刷新失败，请手动刷新"));
      } catch (cause) {
        const error = normalizeError(cause);
        if (session.isCurrent(submittedSession)) setError(error);
        else appMessage.error(`${submittedAccount.source_order_no ?? `账号 ${submittedAccount.id}`}：${error.message}`);
      }
    });
  };

  const close = () => {
    session.invalidate();
    props.onClose();
  };

  return (
    <BusinessActionModal
      title={title}
      fieldCount={21}
      open={open}
      className="inventory-sale-modal"
      destroyOnHidden
      onCancel={close}
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
          <RecoveryCustomerSection title={buyerInfoTitle} customerOptional />
          <DeliveryInfoSection showIntermediary employees={employees} showSaleOperator />
          <SaleFinanceCard
            isConsignment={isConsignment}
            paymentMethod={paymentMethod}
            saleAmount={saleAmount}
            downPayment={downPayment}
            perPeriod={perPeriod}
            plan={plan}
            pools={pools}
          />
          <CustomFieldSections testIdSuffix="inventory-sale" />
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
