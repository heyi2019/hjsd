import { Form } from "antd";
import { useState } from "react";
import { appMessage } from "../shared/ui/appFeedback";
import { transfersApi } from "../shared/api/transfers.api";
import { useAsyncAction } from "../shared/hooks/useAsyncAction";

interface TransferActionsDeps {
  load: () => Promise<void>;
  write: ReturnType<typeof useAsyncAction>;
}

/** 资金池划转写路径：登记池间资金转移。 */
export function useTransferActions({ load, write }: TransferActionsDeps) {
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferForm] = Form.useForm();

  const submitTransfer = async (values: Record<string, unknown>) => {
    await write.run(async () => {
      await transfersApi.create({
        source_pool_id: Number(values.source_pool_id),
        target_pool_id: Number(values.target_pool_id),
        amount: values.amount as string,
        occurred_on: values.occurred_on as string,
        note: values.note as string,
        operator_user_ids: values.operator_user_ids as number[] | undefined,
      });
      appMessage.success("资金池划转已登记");
      setTransferOpen(false);
      transferForm.resetFields();
      await load();
    });
  };

  return {
    transferOpen,
    setTransferOpen,
    transferForm,
    submitTransfer,
  };
}
