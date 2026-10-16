import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";
import "./ResizableModal.css";

type ResizeDirection = "n" | "e" | "s" | "w" | "nw" | "ne" | "sw" | "se";

type ResizableModalProps = {
  children: ReactNode;
  /** 根据当前弹窗宽度返回布局标识，例如 single/double/three/four。 */
  getLayout?: (width: number) => string;
  /** 布局标识写入的属性名，默认是 data-modal-layout。 */
  layoutAttribute?: string;
  mobileBreakpoint?: number;
  minWidth?: number;
  minHeight?: number;
};

/** 可拖动、可四边/四角缩放的通用弹窗外壳。 */
export function ResizableModal({
  children,
  getLayout,
  layoutAttribute = "data-modal-layout",
  mobileBreakpoint = 640,
  minWidth = 520,
  minHeight = 360,
}: ResizableModalProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const widthVariable = "--resizable-modal-width";
  const heightVariable = "--resizable-modal-height";

  useEffect(() => {
    const shell = shellRef.current;
    const modal = shell?.closest<HTMLElement>(".ant-modal");
    if (!modal) return;

    const syncLayout = () => {
      if (!getLayout) return;
      const resizedWidth = Number.parseFloat(modal.style.getPropertyValue(widthVariable));
      const width = Number.isFinite(resizedWidth) ? resizedWidth : modal.getBoundingClientRect().width;
      modal.setAttribute(layoutAttribute, getLayout(width));
    };
    syncLayout();
    const observer = new ResizeObserver(syncLayout);
    observer.observe(modal);
    return () => observer.disconnect();
  }, [getLayout, layoutAttribute]);

  const isMobile = () => window.matchMedia(`(max-width: ${mobileBreakpoint}px)`).matches;

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (isMobile() || event.pointerType !== "mouse" || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("input, textarea, button, [role='combobox'], .ant-select, .ant-picker, .resizable-modal__resize-handle")) return;
    const shell = shellRef.current;
    const modal = shell?.closest<HTMLElement>(".ant-modal");
    if (!shell || !modal) return;

    const initial = modal.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const move = (moveEvent: globalThis.PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (!dragging && Math.hypot(deltaX, deltaY) < 6) return;
      dragging = true;
      moveEvent.preventDefault();
      modal.style.position = "fixed";
      modal.style.left = `${initial.left + deltaX}px`;
      modal.style.top = `${initial.top + deltaY}px`;
      modal.style.margin = "0";
      modal.style.transform = "none";
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const startResize = (event: PointerEvent<HTMLElement>, direction: ResizeDirection) => {
    if (isMobile() || event.button !== 0) return;
    const shell = shellRef.current;
    const modal = shell?.closest<HTMLElement>(".ant-modal");
    if (!shell || !modal) return;

    event.preventDefault();
    event.stopPropagation();
    const initial = modal.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const widthFloor = Math.min(minWidth, window.innerWidth - 32);
    const move = (moveEvent: globalThis.PointerEvent) => {
      moveEvent.preventDefault();
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const fromWest = direction.includes("w");
      const fromNorth = direction.includes("n");
      const width = Math.max(widthFloor, initial.width + (fromWest ? -deltaX : deltaX));
      const height = Math.max(minHeight, initial.height + (fromNorth ? -deltaY : deltaY));
      const left = fromWest ? initial.left + initial.width - width : initial.left;
      const top = fromNorth ? initial.top + initial.height - height : initial.top;

      modal.style.position = "fixed";
      modal.style.left = `${left}px`;
      modal.style.top = `${top}px`;
      modal.style.margin = "0";
      modal.style.transform = "none";
      modal.style.setProperty(widthVariable, `${width}px`);
      modal.style.setProperty(heightVariable, `${height}px`);
      if (getLayout) modal.setAttribute(layoutAttribute, getLayout(width));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  return (
    <div ref={shellRef} className="resizable-modal__drag-shell" onPointerDown={startDrag}>
      {children}
      {(["n", "e", "s", "w", "nw", "ne", "sw", "se"] as ResizeDirection[]).map((direction) => (
        <span
          key={direction}
          aria-hidden="true"
          className={`resizable-modal__resize-handle resizable-modal__resize-handle--${direction}`}
          onPointerDown={(event) => startResize(event, direction)}
        />
      ))}
    </div>
  );
}
