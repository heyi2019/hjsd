import { Form } from "antd";
import { useState } from "react";
import { appMessage } from "../shared/ui/appFeedback";
import { depositsApi } from "../shared/api/deposits.api";
import type { Deposit } from "../shared/api/types/finance";
import { today } from "../shared/lib/format";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";

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
    depositForm.setFieldsValue({
      pool_id: target.pool_id,
      amount: target.paid_amount,
      paid_on: target.paid_on,
      counterparty_id: target.counterparty_id ?? undefined,
      source_order_id: target.source_order_id ?? undefined,
      expected_release_on: target.expected_release_on ?? undefined,
      note: target.note ?? undefined,
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
      const payload = {
        pool_id: Number(values.pool_id),
        amount: values.amount as string,
        paid_on: values.paid_on as string,
        counterparty_id: values.counterparty_id ? Number(values.counterparty_id) : undefined,
        source_order_id: values.source_order_id ? Number(values.source_order_id) : undefined,
        expected_release_on: values.expected_release_on as string | undefined,
        note: values.note as string,
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
      await depositsApi.release(targetId, {
        amount: values.amount as string,
        released_on: values.released_on as string,
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
      await depositsApi.loss(targetId, {
        amount: values.amount as string,
        lost_on: values.lost_on as string,
        category: values.category as string,
        reason: values.reason as string,
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
      await depositsApi.cancel(targetId, {
        cancelled_on: values.cancelled_on as string,
        reason: values.reason as string,
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
