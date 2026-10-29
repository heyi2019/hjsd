import { Modal, type ModalProps } from "antd";
import type { ReactNode } from "react";
import { ResizableModal } from "./AdaptiveFormGrid/ResizableModal";
import { getRecoveryLayout } from "../../orders/recovery/recoveryConfig";

type BusinessActionModalProps = ModalProps;

/**
 * 业务操作弹窗统一外壳。
 *
 * 建单、库存、资金、返点和分期操作都使用同一套弹窗壳，避免某个入口
 * 只复用了表单间距，却漏掉拖拽、缩放、滚动和窄屏适配。
 */
export function BusinessActionModal({ title, width = 1200, wrapClassName, modalRender, ...props }: BusinessActionModalProps) {
  const titleNode: ReactNode = typeof title === "string"
    ? <span className="resizable-modal__drag-handle">{title}</span>
    : title;
  const mergedWrapClassName = ["adaptive-business-modal", "recovery-order-modal", wrapClassName]
    .filter(Boolean)
    .join(" ");
  const renderModal = modalRender ?? ((modal: ReactNode) => (
    <ResizableModal getLayout={getRecoveryLayout} layoutAttribute="data-recovery-layout">
      {modal}
    </ResizableModal>
  ));
  const afterOpenChange = (open: boolean) => {
    props.afterOpenChange?.(open);
    if (!open) return;
    window.requestAnimationFrame(() => {
      const modal = Array.from(document.querySelectorAll<HTMLElement>(".adaptive-business-modal .ant-modal"))
        .find((node) => node.offsetParent !== null)
        ?? document.querySelector<HTMLElement>(".adaptive-business-modal .ant-modal");
      if (!modal) return;
      modal.dataset.recoveryLayout = getRecoveryLayout(modal.getBoundingClientRect().width);
      modal.style.removeProperty("position");
      modal.style.removeProperty("left");
      modal.style.removeProperty("top");
      modal.style.removeProperty("margin");
      modal.style.removeProperty("transform");
      modal.style.removeProperty("--resizable-modal-width");
      modal.style.removeProperty("--resizable-modal-height");
    });
  };

  return (
    <Modal
      {...props}
      title={titleNode}
      width={width}
      wrapClassName={mergedWrapClassName}
      modalRender={renderModal}
      afterOpenChange={afterOpenChange}
    />
  );
}
