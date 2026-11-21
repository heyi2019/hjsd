/** 分期合约表的写操作集合：从 useContractTableController 提取，函数体一字未改。
 * 只负责 13 个写方法，读/状态/表格列仍留在主 controller。 */
import type { Dispatch, SetStateAction } from "react";
import type { FormInstance } from "antd";
import { appMessage } from "../../shared/ui/appFeedback";
import { installmentsApi, type InstallmentListParams } from "../../shared/api/installments.api";
import { ordersApi } from "../../shared/api/orders.api";
import type { Installment, Schedule } from "../../shared/api/types/installments";
import type { Order } from "../../shared/api/types/orders";
import { normalizeError } from "../../shared/api/client";
import { downloadBlob } from "../../shared/api/download";
import { today } from "../../shared/lib/format";
import { cancelRefundSuccess } from "../../shared/lib/cancellationCopy";
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import { formExtraOrUndefined } from "../../shared/lib/formExtra";

export function useContractActions(params: {
  payTarget: Installment | null;
  deliverTarget: Installment | null;
  recoverTarget: Installment | null;
  resaleTarget: Installment | null;
  cancelTarget: Installment | null;
  settleTarget: Installment | null;
  defaultTarget: Installment | null;
  waiveTarget: Schedule | null;
  extendTarget: Schedule | null;
  setPayTarget: Dispatch<SetStateAction<Installment | null>>;
  setDeliverTarget: Dispatch<SetStateAction<Installment | null>>;
  setRecoverTarget: Dispatch<SetStateAction<Installment | null>>;
  setResaleTarget: Dispatch<SetStateAction<Installment | null>>;
  setCancelTarget: Dispatch<SetStateAction<Installment | null>>;
  setSettleTarget: Dispatch<SetStateAction<Installment | null>>;
  setDefaultTarget: Dispatch<SetStateAction<Installment | null>>;
  setWaiveTarget: Dispatch<SetStateAction<Schedule | null>>;
  setExtendTarget: Dispatch<SetStateAction<Schedule | null>>;
  payForm: FormInstance;
  deliverForm: FormInstance;
  recoverForm: FormInstance;
  resaleForm: FormInstance;
  cancelForm: FormInstance;
  settleForm: FormInstance;
  defaultForm: FormInstance;
  waiveForm: FormInstance;
  extendForm: FormInstance;
  write: ReturnType<typeof useAsyncAction>;
  load: () => Promise<void>;
  setError: Dispatch<SetStateAction<{ message: string; code?: string } | null>>;
  setResaleOrders: Dispatch<SetStateAction<Order[]>>;
  setExporting: Dispatch<SetStateAction<boolean>>;
  filters: InstallmentListParams;
}) {
  const {
    payTarget, deliverTarget, recoverTarget, resaleTarget, cancelTarget, settleTarget, defaultTarget, waiveTarget, extendTarget,
    setPayTarget, setDeliverTarget, setRecoverTarget, setResaleTarget, setCancelTarget, setSettleTarget, setDefaultTarget, setWaiveTarget, setExtendTarget,
    payForm, deliverForm, recoverForm, resaleForm, cancelForm, settleForm, defaultForm, waiveForm, extendForm,
    write, load, setError, setResaleOrders, setExporting, filters,
  } = params;

  const exportCsv = async () => {
    setExporting(true);
    try {
      downloadBlob(await installmentsApi.exportCsv(filters), `分期与回款-${today()}.csv`);
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setExporting(false);
    }
  };

  const submitPay = async (values: Record<string, unknown>) => {
    if (!payTarget) return;
    await write.run(async () => {
        await installmentsApi.pay(payTarget.id, {
          amount: values.amount as string,
          paid_on: values.paid_on as string,
          period_no: values.period_no === undefined ? undefined : Number(values.period_no),
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("收款已登记");
        setPayTarget(null);
        payForm.resetFields();
        await load();
    });
  };

  const submitDeliver = async (values: Record<string, unknown>) => {
    if (!deliverTarget) return;
    await write.run(async () => {
        await installmentsApi.deliver(deliverTarget.id, {
          delivered_on: values.delivered_on as string,
          note: values.note as string,
          bound_phone: values.bound_phone ? String(values.bound_phone) : undefined,
          bound_phone_owner: values.bound_phone_owner ? String(values.bound_phone_owner) : undefined,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("已完成交付，不新增现金流");
        setDeliverTarget(null);
        deliverForm.resetFields();
        await load();
    });
  };

  const openDeliver = (row: Installment) => {
    deliverForm.resetFields();
    setDeliverTarget(row);
    deliverForm.setFieldsValue({
      delivered_on: today(),
      bound_phone: row.order.bound_phone ?? undefined,
      bound_phone_owner: row.order.bound_phone_owner ?? undefined,
    });
  };

  const submitRecover = async (values: Record<string, unknown>) => {
    if (!recoverTarget) return;
    await write.run(async () => {
        await installmentsApi.recover(recoverTarget.id, {
          occurred_on: values.occurred_on as string,
          note: values.note as string,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("逾期账号已登记回收");
        setRecoverTarget(null);
        recoverForm.resetFields();
        await load();
    });
  };

  const submitResale = async (values: Record<string, unknown>) => {
    if (!resaleTarget) return;
    await write.run(async () => {
        await installmentsApi.resale(resaleTarget.id, {
          resale_order_id: Number(values.resale_order_id),
          occurred_on: values.occurred_on as string,
          note: values.note as string,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("已登记出售，原分期与出售订单的利润关联保留");
        setResaleTarget(null);
        resaleForm.resetFields();
        await load();
    });
  };

  const openResale = async (row: Installment) => {
    try {
      const orders: Order[] = [];
      while (true) {
        const page = await ordersApi.listPage({ status: "COMPLETED", limit: 500, offset: orders.length });
        if (!page.items.length && orders.length < page.total) throw new Error("出售订单读取不完整，请重试");
        orders.push(...page.items);
        if (orders.length >= page.total) break;
      }
      setResaleOrders(orders);
      resaleForm.resetFields();
      setResaleTarget(row);
      resaleForm.setFieldsValue({ occurred_on: today() });
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitCancel = async (values: Record<string, unknown>) => {
    if (!cancelTarget) return;
    await write.run(async () => {
        const result = await installmentsApi.cancel(cancelTarget.id, {
          cancelled_on: values.cancelled_on as string,
          reason: values.reason as string,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success(cancelRefundSuccess(result.refund_amount, cancelTarget.contract_type));
        setCancelTarget(null);
        cancelForm.resetFields();
        await load();
    });
  };

  const submitSettleEarly = async (values: Record<string, unknown>) => {
    if (!settleTarget) return;
    await write.run(async () => {
        await installmentsApi.settleEarly(settleTarget.id, {
          paid_on: values.paid_on as string,
          pool_id: values.pool_id === undefined ? undefined : Number(values.pool_id),
          note: values.note as string | undefined,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("已提前结清，剩余应收一次性收清");
        setSettleTarget(null);
        settleForm.resetFields();
        await load();
    });
  };

  const submitDefault = async (values: Record<string, unknown>) => {
    if (!defaultTarget) return;
    await write.run(async () => {
        await installmentsApi.markDefault(defaultTarget.id, { reason: values.reason as string, operator_user_ids: values.operator_user_ids as number[] | undefined, form_extra: formExtraOrUndefined(values.form_extra) });
        appMessage.success("已登记违约，合约进入 DEFAULTED");
        setDefaultTarget(null);
        defaultForm.resetFields();
        await load();
    });
  };

  const submitWaive = async (values: Record<string, unknown>) => {
    if (!waiveTarget) return;
    await write.run(async () => {
        await installmentsApi.waiveSchedule(waiveTarget.installment_id, waiveTarget.period_no, {
          amount: values.amount as string,
          waived_on: values.waived_on as string,
          reason: values.reason as string,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("期次减免已登记");
        setWaiveTarget(null);
        waiveForm.resetFields();
        await load();
    });
  };

  const submitExtend = async (values: Record<string, unknown>) => {
    if (!extendTarget) return;
    await write.run(async () => {
        await installmentsApi.extendSchedule(extendTarget.installment_id, extendTarget.period_no, {
          new_due_on: values.new_due_on as string,
          reason: values.reason as string,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("期次展期已登记");
        setExtendTarget(null);
        extendForm.resetFields();
        await load();
    });
  };

  const updateOperationOperators = async (installmentId: number, operationKey: string, operatorUserIds: number[]) => {
    try {
      await installmentsApi.updateOperationOperators(installmentId, operationKey, operatorUserIds);
      appMessage.success("操作人已更新");
      await load();
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    }
  };

  return {
    exportCsv,
    submitPay,
    submitDeliver,
    openDeliver,
    submitRecover,
    submitResale,
    openResale,
    submitCancel,
    submitSettleEarly,
    submitDefault,
    submitWaive,
    submitExtend,
    updateOperationOperators,
  };
}
