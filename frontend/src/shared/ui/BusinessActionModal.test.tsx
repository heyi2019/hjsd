import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLight } from "../../test/render";
import { BusinessActionModal } from "./BusinessActionModal";

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
});
