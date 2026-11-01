import { ConfigProvider, Modal, type ModalProps } from "antd";
import {
  createContext,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
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

  // 每个弹窗从「关闭」切到「打开」时重置布局与滚动位置（P2-194）。
  // 放在 useEffect(open) 而非 afterOpenChange：本仓库用 motion-stub 替掉 rc-motion，
  // rc-motion 的「动画结束」回调不触发，afterOpenChange 在测试里不会回调，
  // 改用 open 副作用可稳定触发且无需等待动画。
  const open = props.open;
  useEffect(() => {
    if (!open) return;
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
    // 新弹窗始终从顶部开始：antd Modal 默认不销毁内容（destroyOnClose=false），
    // 上一弹窗滚动过的 .ant-modal-body 会被复用，导致新弹窗承接旧滚动位置（P2-194）。
    const modalBody = modal.querySelector<HTMLElement>(".ant-modal-body");
    if (modalBody) modalBody.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // L262：内嵌浮层（下拉/日期选择器等）打开时，Esc 应先关浮层，而非直接触发弹窗
  // onCancel（否则会误弹「放弃确认」并可能关闭整个表单弹窗）。
  // 做法：关闭 antd Modal 自带的 Esc→onCancel（keyboard=false），改由本捕获阶段处理器判定——
  // 有浮层打开则放行（让内部组件自己关浮层），无浮层才手动 onCancel。
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const handleKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    const overlayOpen = Boolean(
      document.querySelector(
        ".ant-select-open, .ant-picker-open, .ant-cascader-open, .ant-dropdown:not(.ant-dropdown-hidden)",
      ),
    );
    if (overlayOpen) return; // 有浮层：交给内部组件自行处理 Esc（关浮层）
    // antd 的 ModalProps 将 onCancel 事件窄化为鼠标事件；这里实际来自键盘捕获，
    // 但回调只需要收到一次取消通知，不依赖事件类型。
    onCancelRef.current?.(event as unknown as ReactMouseEvent<HTMLButtonElement>);
  };

  return (
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <Modal
        {...restProps}
        keyboard={false}
        onCancel={onCancel}
        title={titleNode}
        width={resolvedWidth}
        wrapClassName={mergedWrapClassName}
        modalRender={renderModal}
      >
        <ModalCancelContext.Provider value={onCancel as (() => void) | undefined}>
          {/* L262：在内容根挂捕获阶段 Esc 处理器（display:contents 不影响布局）。
              内嵌浮层打开时放行（让内部组件自己关浮层），无浮层才手动 onCancel。 */}
          <div onKeyDownCapture={handleKeyDownCapture} style={{ display: "contents" }}>
            {children}
          </div>
        </ModalCancelContext.Provider>
      </Modal>
    </ConfigProvider>
  );
}
