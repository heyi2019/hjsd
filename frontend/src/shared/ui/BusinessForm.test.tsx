import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLight } from "../../test/render";
import { BusinessForm } from "./BusinessForm";

describe("BusinessForm", () => {
  it("为业务表单提供统一布局、错误滚动和当前表单标识", () => {
    renderLight(
      <BusinessForm scope="SALE">
        <label htmlFor="amount">金额</label>
        <input id="amount" />
      </BusinessForm>,
      { user: "admin" },
    );

    const form = screen.getByRole("textbox").closest("form");
    expect(form).toHaveClass("ui-form-spaced");
    expect(form).toHaveAttribute("data-form-scope", "SALE");
  });
});
