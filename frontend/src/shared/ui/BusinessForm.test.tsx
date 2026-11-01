import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLight } from "../../test/render";
import {
  BusinessRegistrationForm,
  BusinessRegistrationGroup,
  BusinessRegistrationSection,
} from "./BusinessRegistrationForm";

describe("BusinessRegistrationForm", () => {
  it("提供统一布局、错误滚动和当前表单标识", () => {
    renderLight(
      <BusinessRegistrationForm scope="SALE">
        <label htmlFor="amount">金额</label>
        <input id="amount" />
      </BusinessRegistrationForm>,
      { user: "admin" },
    );

    const form = screen.getByRole("textbox").closest("form");
    expect(form).toHaveClass("ui-form-spaced");
    expect(form).toHaveAttribute("data-form-scope", "SALE");
  });

  it("登记表复用建单式横向字段口径", () => {
    renderLight(
      <BusinessRegistrationForm scope="LEAD">
        <label htmlFor="customer">客户</label>
        <input id="customer" />
      </BusinessRegistrationForm>,
      { user: "admin" },
    );

    const form = screen.getByRole("textbox").closest("form");
    expect(form).toHaveClass("business-registration-form", "ant-form-horizontal");
    expect(form).toHaveAttribute("data-form-scope", "LEAD");
  });

  it("提供建单式二级业务分区容器", () => {
    renderLight(
      <BusinessRegistrationSection title="客户信息" description="基础资料">
        <div>字段区域</div>
      </BusinessRegistrationSection>,
      { user: "admin" },
    );

    expect(screen.getByRole("heading", { name: "客户信息" })).toHaveClass("business-registration-section__title");
    expect(screen.getByText("字段区域").parentElement).toHaveClass("business-registration-section__fields");
  });

  it("提供二级容器标题", () => {
    renderLight(
      <BusinessRegistrationGroup title="基础资料" action={<button type="button">增加字段</button>}>
        <div>字段区域</div>
      </BusinessRegistrationGroup>,
      { user: "admin" },
    );

    expect(screen.getByRole("heading", { name: "基础资料" })).toHaveClass("business-registration-group__title");
    expect(screen.getByRole("button", { name: "增加字段" }).parentElement).toHaveClass("business-registration-group__action");
  });
});
