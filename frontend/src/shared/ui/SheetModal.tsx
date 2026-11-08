import { Modal } from "antd";
import type { ModalProps } from "antd";
import { useEffect, useRef } from "react";

/*
 * 底部 Sheet 模态：在 antd Modal 之上叠加「拖拽关闭」——iOS 标准交互。
 * ---------------------------------------------------------------------------
 * 为什么用 MutationObserver 接线（而非仅在 effect 里 querySelector）：
 *   antd v5 的 Modal 在 open=false 且 destroyOnHidden 时**完全不挂载**弹层；open 变 true
 *   后弹层（含 .ant-modal-content）是异步/延迟挂载的。若在 effect 里同步 querySelector，
 *   往往早于弹层挂载而取到 null，导致抓手从未注入、拖拽逻辑不挂载（实测如此）。
 *   故：open 后先立即尝试，再用 MutationObserver 监听 .ant-modal-content 出现再接线，
 *   彻底消除时序竞态。
 *
 * 实现要点（与全站弹簧口径一致，ζ=0.8 / 响应 0.3s = --ease-spring）：
 *   1. 仅当指针落在 抓手 / 标题栏 且未命中交互控件时才接管拖拽，绝不与正文滚动争抢。
 *   2. 拖拽中 translateY 实时跟随；向上为负时走 0.2 橡胶阻尼（橡胶边界）。
 *   3. 松手判定：位移 > max(120px, 35% 高) 或 速度 > 0.5px/ms → 下滑关闭；
 *      否则用 --ease-spring 回弹归位（吸附）。
 *   4. 仅在 ≤640px 挂载手势（桌面端居中模态不需要，也不应被拖）。
 */
const CLOSE_DISTANCE = 120;
const CLOSE_RATIO = 0.35;
const CLOSE_VELOCITY = 0.5; // px/ms
const RUBBER = 0.2;
type ModalCancelEvent = Parameters<NonNullable<ModalProps["onCancel"]>>[0];

export function SheetModal(props: ModalProps & { closeOnDrag?: boolean }) {
  const { className, children, closeOnDrag = true, open, onCancel, ...rest } = props;
  // onCancel 用 ref 持有最新值，effect 不依赖它，避免因父组件每次渲染生成新箭头而反复重跑/重接线。
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!closeOnDrag || !open) return;
    const isMobile = window.matchMedia("(max-width: 640px)").matches;
    if (!isMobile) return;

    let dragging = false;
    let startY = 0;
    let lastY = 0;
    let lastT = 0;
    let dy = 0;
    let velocity = 0;
    let content: HTMLElement | null = null;

    const clearInline = () => {
      if (!content) return;
      content.style.transition = "";
      content.style.transform = "";
      content.style.animation = "";
    };

    const onMove = (e: PointerEvent) => {
      if (!dragging || !content) return;
      dy = e.clientY - startY;
      const now = performance.now();
      const dt = Math.max(1, now - lastT);
      velocity = (e.clientY - lastY) / dt;
      lastY = e.clientY;
      lastT = now;
      const t = dy < 0 ? dy * RUBBER : dy; // 向上为负：橡胶阻尼；向下：1:1 跟随
      content.style.transform = `translateY(${t}px)`;
    };

    const onUp = () => {
      if (!dragging || !content) return;
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);

      const h = content.offsetHeight;
      const shouldClose = dy > Math.max(CLOSE_DISTANCE, h * CLOSE_RATIO) || velocity > CLOSE_VELOCITY;

      if (shouldClose) {
        content.style.transition = "transform 0.28s cubic-bezier(0.22, 0.61, 0.36, 1)";
        content.style.transform = "translateY(110%)";
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          content?.removeEventListener("transitionend", finish);
          clearInline();
          onCancelRef.current?.({} as ModalCancelEvent);
        };
        content.addEventListener("transitionend", finish);
        window.setTimeout(finish, 360); // 兜底：transitionend 未触发（如降级动画）
      } else {
        content.style.transition = "transform var(--dur-spring) var(--ease-spring)";
        content.style.transform = "translateY(0)";
        let done = false;
        const settle = () => {
          if (done) return;
          done = true;
          content?.removeEventListener("transitionend", settle);
          clearInline();
        };
        content.addEventListener("transitionend", settle);
        window.setTimeout(settle, 600);
      }
    };

    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      const onHandle = Boolean(target.closest(".sheet-grabber"));
      const onHeader = Boolean(target.closest(".ant-modal-header"));
      if (!onHandle && !onHeader) return;
      if (target.closest("button, a, input, select, textarea")) return; // 标题栏按钮不触发拖拽
      dragging = true;
      startY = e.clientY;
      lastY = e.clientY;
      lastT = performance.now();
      dy = 0;
      velocity = 0;
      if (content) {
        content.style.transition = "none";
        content.style.animation = "none";
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
      }
    };

    let observer: MutationObserver | null = null;
    const wire = () => {
      const el = document.querySelector<HTMLElement>(".mobile-sheet .ant-modal-content");
      if (!el || el.dataset.sheetWired === "1") return;
      el.dataset.sheetWired = "1";
      content = el;
      // 真实插入抓手到内容顶部（modalRender 在 v5 会把它丢到对话框外，故手动 prepend）。
      const grabber = document.createElement("div");
      grabber.className = "sheet-grabber";
      grabber.setAttribute("aria-hidden", "true");
      el.prepend(grabber);
      el.addEventListener("pointerdown", onDown);
    };

    wire(); // open 后可能已挂载，先立即尝试
    observer = new MutationObserver(() => wire()); // 未挂载则监听其出现
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer?.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (content) {
        content.removeEventListener("pointerdown", onDown);
        content.querySelector(".sheet-grabber")?.remove();
        content.dataset.sheetWired = "";
        clearInline();
      }
      content = null;
    };
  }, [open, closeOnDrag]);

  return (
    <Modal
      {...rest}
      open={open}
      onCancel={onCancel}
      className={`mobile-sheet ${className ?? ""}`.trim()}
    >
      {children}
    </Modal>
  );
}
