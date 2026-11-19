/** 分期合约动作 Modal 整合出口（9 个动作 + 共用骨架）。

实现已拆至 `installments/panel-modals/`（_shared / payment-modals / contract-modals）；
本文件保留 `ContractModals` 聚合出口与全部符号 re-export，调用方无需改动。
 */
import type { ContractTableController } from "./useContractTableController";
import { PayModal, SettleModal, WaiveModal, ExtendModal } from "./panel-modals/payment-modals";
import { RecoverModal, ResaleModal, DeliverModal, CancelModal, DefaultModal } from "./panel-modals/contract-modals";

export function ContractModals({ controller }: { controller: ContractTableController }) {
  return (
    <>
      <PayModal controller={controller} />
      <RecoverModal controller={controller} />
      <ResaleModal controller={controller} />
      <DeliverModal controller={controller} />
      <CancelModal controller={controller} />
      <SettleModal controller={controller} />
      <DefaultModal controller={controller} />
      <WaiveModal controller={controller} />
      <ExtendModal controller={controller} />
    </>
  );
}

export {
  InstallmentActionModal,
  Modal,
  type WriteState,
  type InstallmentActionModalProps,
} from "./panel-modals/_shared";
export { PayModal, SettleModal, WaiveModal, ExtendModal } from "./panel-modals/payment-modals";
export { RecoverModal, ResaleModal, DeliverModal, CancelModal, DefaultModal } from "./panel-modals/contract-modals";
