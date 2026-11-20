import { Form } from "antd";
import { useState } from "react";
import { appMessage } from "../shared/ui/appFeedback";
import { depositsApi } from "../shared/api/deposits.api";
import type { Deposit } from "../shared/api/types/finance";
import { today } from "../shared/lib/format";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";
import { mergeFormExtra } from "./formExtra";

interface DepositActionsDeps {
  load: () => Promise<void>;
  write: ReturnType<typeof useAsyncAction>;
}

/** 押金占用写路径：登记、编辑、删除、释放、损失和取消。 */
export function useDepositActions({ load, write }: DepositActionsDeps) {
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositEditTarget, setDepositEditTarget] = useState<Deposit | null>(null);
  const [returnTarget, setReturnTarget] = useState<Deposit | null>(null);
  const [lossTarget, setLossTarget] = useState<Deposit | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Deposit | null>(null);
  const [depositForm] = Form.useForm();
  const [returnForm] = Form.useForm();
  const [lossForm] = Form.useForm();
  const [cancelForm] = Form.useForm();

  const openDepositCreate = () => {
    setDepositEditTarget(null);
    depositForm.resetFields();
    depositForm.setFieldsValue({ paid_on: today() });
    setDepositOpen(true);
  };

  const openDepositEdit = (target: Deposit) => {
    setDepositEditTarget(target);
    depositForm.resetFields();
    depositForm.setFieldsValue({
      pool_id: target.pool_id,
      ledger_type: target.ledger_type ?? "BUSINESS",
      amount: target.paid_amount,
      paid_on: target.paid_on,
      counterparty_id: target.counterparty_id ?? undefined,
      source_order_id: target.source_order_id ?? undefined,
      expected_release_on: target.expected_release_on ?? undefined,
      note: target.note ?? undefined,
      form_extra: target.form_extra ?? undefined,
      operator_user_ids: target.operation_operators?.find((item) => item.operation_key === "CREATE")?.operator_user_ids,
    });
    setDepositOpen(true);
  };

  const closeDeposit = () => {
    setDepositOpen(false);
    setDepositEditTarget(null);
    depositForm.resetFields();
  };

  const submitDeposit = async (values: Record<string, unknown>) => {
    const editing = depositEditTarget;
    await write.run(async () => {
      const ledgerType = (values.ledger_type as string) || "BUSINESS";
      const formExtra = mergeFormExtra(values.form_extra, editing?.form_extra);
      const payload = {
        pool_id: Number(values.pool_id),
        amount: values.amount as string,
        paid_on: values.paid_on as string,
        ledger_type: ledgerType,
        counterparty_id: values.counterparty_id ? Number(values.counterparty_id) : undefined,
        // 工作室运营押金不属于订单，前端也剔除来源订单避免后端校验拦截。
        source_order_id: ledgerType === "STUDIO" ? undefined : values.source_order_id ? Number(values.source_order_id) : undefined,
        expected_release_on: values.expected_release_on as string | undefined,
        note: values.note as string,
        ...(Object.keys(formExtra).length || (editing && (editing.form_extra != null || values.form_extra != null))
          ? { form_extra: formExtra } : {}),
        operator_user_ids: values.operator_user_ids as number[] | undefined,
      };
      if (editing) {
        await depositsApi.update(editing.id, payload);
        appMessage.success("押金占用已更新");
      } else {
        await depositsApi.create(payload);
        appMessage.success("押金占用已登记，不影响经营损益");
      }
      closeDeposit();
      await load();
    });
  };

  const deleteDeposit = async (depositId: number) => {
    await write.run(async () => {
      await depositsApi.remove(depositId);
      appMessage.success("押金占用已删除");
      await load();
    });
  };

  const submitReturn = async (values: Record<string, unknown>) => {
    if (!returnTarget) return;
    const targetId = returnTarget.id;
    await write.run(async () => {
      const formExtra = mergeFormExtra(values.form_extra);
      await depositsApi.release(targetId, {
        amount: values.amount as string,
        released_on: values.released_on as string,
        ...(Object.keys(formExtra).length ? { form_extra: formExtra } : {}),
        operator_user_ids: values.operator_user_ids as number[] | undefined,
      });
      appMessage.success("押金释放已登记");
      setReturnTarget(null);
      returnForm.resetFields();
      await load();
    });
  };

  const submitLoss = async (values: Record<string, unknown>) => {
    if (!lossTarget) return;
    const targetId = lossTarget.id;
    await write.run(async () => {
      const formExtra = mergeFormExtra(values.form_extra);
      await depositsApi.loss(targetId, {
        amount: values.amount as string,
        lost_on: values.lost_on as string,
        category: values.category as string,
        reason: values.reason as string,
        ...(Object.keys(formExtra).length ? { form_extra: formExtra } : {}),
        operator_user_ids: values.operator_user_ids as number[] | undefined,
      });
      appMessage.success("押金损失已登记");
      setLossTarget(null);
      lossForm.resetFields();
      await load();
    });
  };

  const submitCancelDeposit = async (values: Record<string, unknown>) => {
    if (!cancelTarget) return;
    const targetId = cancelTarget.id;
    await write.run(async () => {
      const formExtra = mergeFormExtra(values.form_extra);
      await depositsApi.cancel(targetId, {
        cancelled_on: values.cancelled_on as string,
        reason: values.reason as string,
        ...(Object.keys(formExtra).length ? { form_extra: formExtra } : {}),
        operator_user_ids: values.operator_user_ids as number[] | undefined,
      });
      appMessage.success("押金已取消，已生成全额冲正流水");
      setCancelTarget(null);
      cancelForm.resetFields();
      await load();
    });
  };

  return {
    depositOpen,
    setDepositOpen,
    depositEditTarget,
    openDepositCreate,
    openDepositEdit,
    closeDeposit,
    returnTarget,
    setReturnTarget,
    lossTarget,
    setLossTarget,
    cancelTarget,
    setCancelTarget,
    depositForm,
    returnForm,
    lossForm,
    cancelForm,
    submitDeposit,
    deleteDeposit,
    submitReturn,
    submitLoss,
    submitCancelDeposit,
  };
}
