/** 分期合约动作弹窗组合。 */
import type { ContractTableController } from "./useContractTableController";
import { PayModal, SettleModal, WaiveModal, ExtendModal } from "./panel-modals/payment-modals";
import { RecoverModal, DeliverModal, CancelModal, DefaultModal } from "./panel-modals/contract-modals";

export function ContractModals({ controller }: { controller: ContractTableController }) {
  return (
    <>
      <PayModal controller={controller} />
      <RecoverModal controller={controller} />
      <DeliverModal controller={controller} />
      <CancelModal controller={controller} />
      <SettleModal controller={controller} />
      <DefaultModal controller={controller} />
      <WaiveModal controller={controller} />
      <ExtendModal controller={controller} />
    </>
  );
}
