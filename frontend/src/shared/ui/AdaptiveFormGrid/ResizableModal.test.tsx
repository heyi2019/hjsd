import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ResizableModal } from "./ResizableModal";

/** 构造可靠的 pointer 事件：jsdom 可能无原生 PointerEvent，
 *  故用 MouseEvent（原生支持 clientX/clientY/button）+ defineProperty 注入 pointerType。 */
function makePointer(
  type: string,
  clientX: number,
  clientY: number,
  opts: { pointerType?: string; button?: number } = {}
) {
  const evt = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: opts.button ?? 0,
  });
  Object.defineProperty(evt, "pointerType", { value: opts.pointerType ?? "mouse" });
  return evt;
}

/** 统一初始矩形（left/top=100，宽 600 高 400），使拖动/缩放位移可精确断言。 */
const RECT = { left: 100, top: 100, width: 600, height: 400 };

function stubRect(modal: HTMLElement) {
  modal.getBoundingClientRect = () =>
    ({
      ...RECT,
      right: RECT.left + RECT.width,
      bottom: RECT.top + RECT.height,
      x: RECT.left,
      y: RECT.top,
      toJSON: () => "",
    }) as DOMRect;
}

function renderInModal(node: ReactNode) {
  const result = render(<div className="ant-modal">{node}</div>);
  const modal = result.container.querySelector(".ant-modal") as HTMLElement;
  return { ...result, modal };
}

const layout = (w: number) => (w >= 640 ? "double" : "single");

describe("ResizableModal 可拖拽缩放弹窗外壳", () => {
  it("渲染 8 个方向缩放手柄", () => {
    renderInModal(
      <ResizableModal>
        <span>内容</span>
      </ResizableModal>
    );
    expect(screen.getByText("内容")).toBeInTheDocument();
    expect(document.querySelectorAll(".resizable-modal__resize-handle")).toHaveLength(8);
  });

  it("无 .ant-modal 祖先时不做任何布局同步（安全早退）", () => {
    const spy = vi.fn(layout);
    render(
      <ResizableModal getLayout={spy}>
        <span>孤儿</span>
      </ResizableModal>
    );
    expect(screen.getByText("孤儿")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("挂载时按当前宽度同步默认布局属性 data-modal-layout", () => {
    const { modal } = renderInModal(
      <ResizableModal getLayout={layout}>
        <span>同步</span>
      </ResizableModal>
    );
    // jsdom 初始矩形宽为 0 → getLayout(0) → single
    expect(modal.getAttribute("data-modal-layout")).toBe("single");
  });

  it("支持自定义 layoutAttribute 属性名", () => {
    const { modal } = renderInModal(
      <ResizableModal getLayout={layout} layoutAttribute="data-my-layout">
        <span>自定义</span>
      </ResizableModal>
    );
    expect(modal.getAttribute("data-my-layout")).toBe("single");
    expect(modal.getAttribute("data-modal-layout")).toBeNull();
  });

  it("未提供 getLayout 时不写入布局属性", () => {
    const { modal } = renderInModal(
      <ResizableModal>
        <span>无布局</span>
      </ResizableModal>
    );
    expect(modal.getAttribute("data-modal-layout")).toBeNull();
  });

  it("拖动：超过 6px 阈值后改为 fixed 定位并更新 left/top", () => {
    const { modal } = renderInModal(
      <ResizableModal>
        <span>拖我</span>
      </ResizableModal>
    );
    stubRect(modal);
    const shell = document.querySelector(".resizable-modal__drag-shell") as HTMLElement;
    fireEvent(shell, makePointer("pointerdown", 50, 50));
    window.dispatchEvent(makePointer("pointermove", 70, 75));
    expect(modal.style.position).toBe("fixed");
    expect(modal.style.left).toBe("120px");
    expect(modal.style.top).toBe("125px");
    expect(modal.style.margin).toBe("0px");
    window.dispatchEvent(makePointer("pointerup", 70, 75));
  });

  it("拖动：未达 6px 阈值不产生位移", () => {
    const { modal } = renderInModal(
      <ResizableModal>
        <span>微移</span>
      </ResizableModal>
    );
    stubRect(modal);
    const shell = document.querySelector(".resizable-modal__drag-shell") as HTMLElement;
    fireEvent(shell, makePointer("pointerdown", 50, 50));
    window.dispatchEvent(makePointer("pointermove", 52, 52));
    expect(modal.style.position).toBe("");
    window.dispatchEvent(makePointer("pointerup", 52, 52));
  });

  it("拖动：在 button/input 上按下不触发拖动", () => {
    const { modal } = renderInModal(
      <ResizableModal>
        <button type="button">内有按钮</button>
      </ResizableModal>
    );
    stubRect(modal);
    fireEvent(screen.getByRole("button", { name: /内有按钮/ }), makePointer("pointerdown", 50, 50));
    window.dispatchEvent(makePointer("pointermove", 90, 90));
    expect(modal.style.position).toBe("");
  });

  it("拖动：非鼠标指针类型（touch）不触发", () => {
    const { modal } = renderInModal(
      <ResizableModal>
        <span>触屏</span>
      </ResizableModal>
    );
    stubRect(modal);
    const shell = document.querySelector(".resizable-modal__drag-shell") as HTMLElement;
    fireEvent(shell, makePointer("pointerdown", 50, 50, { pointerType: "touch" }));
    window.dispatchEvent(makePointer("pointermove", 90, 90));
    expect(modal.style.position).toBe("");
  });

  it("拖动：移动端（matchMedia 命中窄屏）不触发", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const { modal } = renderInModal(
      <ResizableModal>
        <span>窄屏</span>
      </ResizableModal>
    );
    stubRect(modal);
    const shell = document.querySelector(".resizable-modal__drag-shell") as HTMLElement;
    fireEvent(shell, makePointer("pointerdown", 50, 50));
    window.dispatchEvent(makePointer("pointermove", 90, 90));
    expect(modal.style.position).toBe("");
  });

  it("缩放：向东拉宽写入宽高 CSS 变量并更新布局属性", () => {
    const { modal } = renderInModal(
      <ResizableModal getLayout={layout}>
        <span>放大</span>
      </ResizableModal>
    );
    stubRect(modal);
    const east = document.querySelector(".resizable-modal__resize-handle--e") as HTMLElement;
    fireEvent(east, makePointer("pointerdown", 50, 50));
    window.dispatchEvent(makePointer("pointermove", 100, 60));
    expect(modal.style.getPropertyValue("--resizable-modal-width")).toBe("650px");
    expect(modal.style.getPropertyValue("--resizable-modal-height")).toBe("410px");
    expect(modal.style.left).toBe("100px");
    expect(modal.getAttribute("data-modal-layout")).toBe("double");
    window.dispatchEvent(makePointer("pointerup", 100, 60));
  });

  it("缩放：向西拉且宽度被 minWidth 钳制时左边界右移", () => {
    const { modal } = renderInModal(
      <ResizableModal getLayout={layout}>
        <span>西钳制</span>
      </ResizableModal>
    );
    stubRect(modal);
    const west = document.querySelector(".resizable-modal__resize-handle--w") as HTMLElement;
    fireEvent(west, makePointer("pointerdown", 50, 50));
    window.dispatchEvent(makePointer("pointermove", 250, 50));
    expect(modal.style.getPropertyValue("--resizable-modal-width")).toBe("520px");
    expect(modal.style.left).toBe("180px");
    window.dispatchEvent(makePointer("pointerup", 250, 50));
  });

  it("缩放：向北拉且高度被 minHeight 钳制时上边界下移", () => {
    const { modal } = renderInModal(
      <ResizableModal getLayout={layout}>
        <span>北钳制</span>
      </ResizableModal>
    );
    stubRect(modal);
    const north = document.querySelector(".resizable-modal__resize-handle--n") as HTMLElement;
    fireEvent(north, makePointer("pointerdown", 50, 50));
    window.dispatchEvent(makePointer("pointermove", 50, 150));
    expect(modal.style.getPropertyValue("--resizable-modal-height")).toBe("360px");
    expect(modal.style.top).toBe("140px");
    window.dispatchEvent(makePointer("pointerup", 50, 150));
  });
});
