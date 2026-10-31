import { ConfigProvider, Modal, type ModalProps } from "antd";
import { createContext, type ReactNode } from "react";
import { ResizableModal } from "./AdaptiveFormGrid/ResizableModal";
import { getRecoveryLayout } from "../../orders/recovery/recoveryConfig";

/**
 * 把弹窗自身的 onCancel 下发给内部子组件（CompactActions 渲染「取消」用）。
 * 否则每个紧凑弹窗都得把 onCancel 手动透传一遍——既冗余又易漏。
 */
export const ModalCancelContext = createContext<(() => void) | undefined>(undefined);

type BusinessActionModalProps = ModalProps;

/**
 * 两套弹窗表单规格（尺寸与页脚按钮口径不同，其余外壳完全一致）：
 *  - full（默认）：建单/售出/返点等完整表单。1200 宽，页脚为满宽大按钮。
 *  - compact：只有 1~3 个字段的操作弹窗（重置密码、关闭工单、锁定账期 …）。
 *    560 宽，页脚按钮恢复语义宽度与标准控件高度——字段少的弹窗用满宽大按钮
 *    会出现「两个又长又高的按钮」，与表单体量严重不匹配。
 */
export type BusinessModalSize = "full" | "compact";

/**
 * 业务操作弹窗统一外壳。
 *
 * 建单、库存、资金、返点和分期操作都使用同一套弹窗壳，避免某个入口
 * 只复用了表单间距，却漏掉拖拽、缩放、滚动和窄屏适配。
 */
export function BusinessActionModal({
  title,
  size = "full",
  width,
  wrapClassName,
  modalRender,
  ...props
}: BusinessActionModalProps & { size?: BusinessModalSize }) {
  const { children, onCancel, ...restProps } = props;
  const titleNode: ReactNode = typeof title === "string"
    ? <span className="resizable-modal__drag-handle">{title}</span>
    : title;
  const mergedWrapClassName = [
    "adaptive-business-modal",
    "recovery-order-modal",
    size === "compact" ? "compact-form-modal" : null,
    wrapClassName,
  ]
    .filter(Boolean)
    .join(" ");
  const resolvedWidth = width ?? (size === "compact" ? 560 : 1200);
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
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <Modal
        {...restProps}
        onCancel={onCancel}
        title={titleNode}
        width={resolvedWidth}
        wrapClassName={mergedWrapClassName}
        modalRender={renderModal}
        afterOpenChange={afterOpenChange}
      >
        <ModalCancelContext.Provider value={onCancel as (() => void) | undefined}>{children}</ModalCancelContext.Provider>
      </Modal>
    </ConfigProvider>
  );
}
