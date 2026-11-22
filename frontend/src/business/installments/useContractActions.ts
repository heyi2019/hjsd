/** 分期合约的写操作与导出。 */
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { appMessage } from "../../shared/ui/appFeedback";
import { installmentsApi, type InstallmentListParams } from "../../shared/api/installments.api";
import { ordersApi } from "../../shared/api/orders.api";
import type { Installment } from "../../shared/api/types/installments";
import type { Order } from "../../shared/api/types/orders";
import { normalizeError } from "../../shared/api/client";
import { downloadBlob } from "../../shared/api/download";
import { today } from "../../shared/lib/format";
import { cancelRefundSuccess } from "../../shared/lib/cancellationCopy";
import { formExtraOrUndefined } from "../../shared/lib/formExtra";
import type { useContractModalState } from "./useContractModalState";

export function useContractActions(params: {
  active: boolean;
  modal: ReturnType<typeof useContractModalState>;
  load: () => Promise<void>;
  setError: Dispatch<SetStateAction<{ message: string; code?: string } | null>>;
  setResaleOrders: Dispatch<SetStateAction<Order[]>>;
  setExporting: Dispatch<SetStateAction<boolean>>;
  filters: InstallmentListParams;
}) {
  const { active, modal, load, setError, setResaleOrders, setExporting, filters } = params;
  const {
    payTarget, deliverTarget, recoverTarget, resaleTarget, cancelTarget, settleTarget, defaultTarget, waiveTarget, extendTarget,
    setPayTarget, setDeliverTarget, setRecoverTarget, setResaleTarget, setCancelTarget, setSettleTarget, setDefaultTarget, setWaiveTarget, setExtendTarget,
    payForm, deliverForm, recoverForm, resaleForm, cancelForm, settleForm, defaultForm, waiveForm, extendForm,
    write, actionSession,
  } = modal;
  const resaleRequest = useRef(0);
  useEffect(() => () => { resaleRequest.current += 1; }, [active]);

  const runAction = async (action: (isCurrent: () => boolean) => Promise<void>) => {
    const session = actionSession.current();
    const isCurrent = () => actionSession.isCurrent(session);
    await write.run(async () => {
      try {
        await action(isCurrent);
      } catch (error) {
        if (isCurrent()) throw error;
        appMessage.error(normalizeError(error).message);
      }
    });
  };

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
    await runAction(async (isCurrent) => {
        await installmentsApi.pay(payTarget.id, {
          amount: values.amount as string,
          paid_on: values.paid_on as string,
          period_no: values.period_no === undefined ? undefined : Number(values.period_no),
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("收款已登记");
        if (isCurrent()) {
          setPayTarget(null);
          payForm.resetFields();
        }
        await load();
    });
  };

  const submitDeliver = async (values: Record<string, unknown>) => {
    if (!deliverTarget) return;
    await runAction(async (isCurrent) => {
        await installmentsApi.deliver(deliverTarget.id, {
          delivered_on: values.delivered_on as string,
          note: values.note as string,
          bound_phone: values.bound_phone ? String(values.bound_phone) : undefined,
          bound_phone_owner: values.bound_phone_owner ? String(values.bound_phone_owner) : undefined,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("已完成交付，不新增现金流");
        if (isCurrent()) {
          setDeliverTarget(null);
          deliverForm.resetFields();
        }
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
    await runAction(async (isCurrent) => {
        await installmentsApi.recover(recoverTarget.id, {
          recovery_cost: String(values.recovery_cost),
          occurred_on: values.occurred_on as string,
          note: values.note as string,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("逾期账号已登记回收");
        if (isCurrent()) {
          setRecoverTarget(null);
          recoverForm.resetFields();
        }
        await load();
    });
  };

  const submitResale = async (values: Record<string, unknown>) => {
    if (!resaleTarget) return;
    await runAction(async (isCurrent) => {
        await installmentsApi.resale(resaleTarget.id, {
          resale_order_id: Number(values.resale_order_id),
          occurred_on: values.occurred_on as string,
          note: values.note as string,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("已登记出售，原分期与出售订单的利润关联保留");
        if (isCurrent()) {
          setResaleTarget(null);
          resaleForm.resetFields();
        }
        await load();
    });
  };

  const openResale = async (row: Installment) => {
    const request = ++resaleRequest.current;
    const session = actionSession.current();
    const isCurrent = () => request === resaleRequest.current && actionSession.isCurrent(session);
    try {
      const orders: Order[] = [];
      while (true) {
        const page = await ordersApi.listPage({ status: "COMPLETED", limit: 500, offset: orders.length });
        if (!isCurrent()) return;
        if (!page.items.length && orders.length < page.total) throw new Error("出售订单读取不完整，请重试");
        orders.push(...page.items);
        if (orders.length >= page.total) break;
      }
      setResaleOrders(orders);
      resaleForm.resetFields();
      setResaleTarget(row);
      resaleForm.setFieldsValue({ occurred_on: today() });
    } catch (err) {
      if (isCurrent()) setError(normalizeError(err));
    }
  };

  const submitCancel = async (values: Record<string, unknown>) => {
    if (!cancelTarget) return;
    await runAction(async (isCurrent) => {
        const result = await installmentsApi.cancel(cancelTarget.id, {
          cancelled_on: values.cancelled_on as string,
          reason: values.reason as string,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success(cancelRefundSuccess(result.refund_amount, cancelTarget.contract_type));
        if (isCurrent()) {
          setCancelTarget(null);
          cancelForm.resetFields();
        }
        await load();
    });
  };

  const submitSettleEarly = async (values: Record<string, unknown>) => {
    if (!settleTarget) return;
    await runAction(async (isCurrent) => {
        await installmentsApi.settleEarly(settleTarget.id, {
          paid_on: values.paid_on as string,
          pool_id: values.pool_id === undefined ? undefined : Number(values.pool_id),
          note: values.note as string | undefined,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("已提前结清，剩余应收一次性收清");
        if (isCurrent()) {
          setSettleTarget(null);
          settleForm.resetFields();
        }
        await load();
    });
  };

  const submitDefault = async (values: Record<string, unknown>) => {
    if (!defaultTarget) return;
    await runAction(async (isCurrent) => {
        await installmentsApi.markDefault(defaultTarget.id, { reason: values.reason as string, operator_user_ids: values.operator_user_ids as number[] | undefined, form_extra: formExtraOrUndefined(values.form_extra) });
        appMessage.success("已登记违约，合约进入 DEFAULTED");
        if (isCurrent()) {
          setDefaultTarget(null);
          defaultForm.resetFields();
        }
        await load();
    });
  };

  const submitWaive = async (values: Record<string, unknown>) => {
    if (!waiveTarget) return;
    await runAction(async (isCurrent) => {
        await installmentsApi.waiveSchedule(waiveTarget.installment_id, waiveTarget.period_no, {
          amount: values.amount as string,
          waived_on: values.waived_on as string,
          reason: values.reason as string,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("期次减免已登记");
        if (isCurrent()) {
          setWaiveTarget(null);
          waiveForm.resetFields();
        }
        await load();
    });
  };

  const submitExtend = async (values: Record<string, unknown>) => {
    if (!extendTarget) return;
    await runAction(async (isCurrent) => {
        await installmentsApi.extendSchedule(extendTarget.installment_id, extendTarget.period_no, {
          new_due_on: values.new_due_on as string,
          reason: values.reason as string,
          operator_user_ids: values.operator_user_ids as number[] | undefined,
          form_extra: formExtraOrUndefined(values.form_extra),
        });
        appMessage.success("期次展期已登记");
        if (isCurrent()) {
          setExtendTarget(null);
          extendForm.resetFields();
        }
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
