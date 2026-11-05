import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLight } from "@fixtures/render";
import { BusinessRegistrationModal } from "@/shared/ui/BusinessRegistrationModal";

describe("BusinessRegistrationModal", () => {
  it("一次调用组合标准弹窗和注册表", () => {
    renderLight(
      <BusinessRegistrationModal
        open
        title="新建客户"
        fieldCount={3}
        onCancel={() => undefined}
        formProps={{ scope: "CUSTOMER" }}
      >
        <div>客户字段</div>
      </BusinessRegistrationModal>,
      { user: "admin" },
    );

    expect(screen.getByText("新建客户")).toBeInTheDocument();
    expect(document.querySelector(".business-registration-modal .business-registration-form")).toHaveAttribute("data-form-scope", "CUSTOMER");
    expect(document.querySelector(".business-form-layout-1x5")).toBeInTheDocument();
  });
});
