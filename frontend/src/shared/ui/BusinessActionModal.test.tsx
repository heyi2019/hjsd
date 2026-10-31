import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLight } from "../../test/render";
import { BusinessActionModal } from "./BusinessActionModal";
import { CompactActions } from "./CompactActions";

describe("BusinessActionModal", () => {
  it("复用建单弹窗的完整可拖拽缩放外壳", () => {
    renderLight(
      <BusinessActionModal open title="资金收支" onCancel={() => undefined}>
        <div>内容</div>
      </BusinessActionModal>,
      { user: "admin" },
    );

    expect(document.querySelector(".adaptive-business-modal.recovery-order-modal")).toBeTruthy();
    expect(document.querySelector(".resizable-modal__drag-handle")).toHaveTextContent("资金收支");
    expect(screen.getByText("内容")).toBeInTheDocument();
  });

  it("size=compact 追加紧凑表单类，且不再套用建单大弹窗尺寸", () => {
    renderLight(
      <BusinessActionModal open size="compact" title="锁定账期" onCancel={() => undefined}>
        <div>内容</div>
      </BusinessActionModal>,
      { user: "admin" },
    );

    // 紧凑规格仍保留 recovery-order-modal 的滚动/防溢出外壳，只追加尺寸与页脚覆盖类。
    expect(document.querySelector(".adaptive-business-modal.recovery-order-modal.compact-form-modal")).toBeTruthy();
    const modal = document.querySelector<HTMLElement>(".ant-modal");
    expect(modal?.style.width).toBe("560px");
  });

  it("size=compact 时显式 width 优先于默认 560", () => {
    renderLight(
      <BusinessActionModal open size="compact" width={720} title="锁定账期" onCancel={() => undefined}>
        <div>内容</div>
      </BusinessActionModal>,
      { user: "admin" },
    );

    expect(document.querySelector<HTMLElement>(".ant-modal")?.style.width).toBe("720px");
  });

  it("compact 弹窗内按钮不插入中文字符间距（autoInsertSpace=false）", () => {
    renderLight(
      <BusinessActionModal open size="compact" title="锁定账期" onCancel={() => undefined}>
        <CompactActions>
          <button type="submit">确认</button>
        </CompactActions>
      </BusinessActionModal>,
      { user: "admin" },
    );

    const cancel = screen.getByText("取消").closest("button");
    // antd 默认会在两个中文字符间插入空格（渲染成「取 消」），此处应已关闭。
    expect(cancel).toBeTruthy();
    expect(cancel!.textContent).toBe("取消");
    expect(cancel!.textContent).not.toContain(" ");
  });
});
