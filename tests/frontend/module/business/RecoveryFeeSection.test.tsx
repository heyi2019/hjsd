import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, Form } from "antd";
import { vi } from "vitest";
import type { ReactElement } from "react";
import type { Pool } from "@/shared/api/types/finance";
import type { OrderFormField } from "@/shared/api/types/forms";
import { renderLight } from "@fixtures/render";
import { FieldConfigContext, type FieldConfigMap } from "@/business/ConfigurableField";
import { RecoveryFeeSection } from "@/business/shared/order-create/recovery/RecoveryFeeSection";

const makeField = (over: Partial<OrderFormField> = {}): OrderFormField => ({
  id: 1,
  order_type_code: "HS",
  field_key: "k",
  label: "字段",
  field_type: "TEXT",
  options: null,
  required: false,
  is_active: true,
  sort_order: 0,
  locked: false,
  is_custom: false,
  note: null,
  ...over,
});

const pools: Pool[] = [];

function renderHs(cfg: FieldConfigMap) {
  return renderLight(
    <Form>
      <FieldConfigContext.Provider value={cfg}>
        <RecoveryFeeSection pools={pools} />
      </FieldConfigContext.Provider>
    </Form>,
  );
}

function renderHsWithSubmit(onFinish: () => void) {
  return renderLight(
    <Form onFinish={onFinish}>
      <FieldConfigContext.Provider value={{}}>
        <RecoveryFeeSection pools={pools} />
      </FieldConfigContext.Provider>
      <Button htmlType="submit">提交</Button>
    </Form>,
  );
}

it("HS 费用卡片：回收金额标题跟随配置改名", () => {
  renderHs({
    recovery_price: makeField({ field_key: "recovery_price", label: "回收结算价", field_type: "NUMBER", required: true }),
  });
  expect(screen.getByText("回收结算价")).toBeInTheDocument();
});

it("HS 费用卡片：无配置时降级显示原硬编码标题", () => {
  renderHs({});
  expect(screen.getByText("回收金额")).toBeInTheDocument();
});

it("HS 费用卡片：保留主金额、资金账户和支出入口", () => {
  renderHs({});
  expect(screen.getByRole("textbox", { name: /回收金额/ })).toHaveAttribute("autocomplete", "off");
  expect(screen.getByRole("button", { name: /增加支出/ })).toBeInTheDocument();
  expect(screen.queryByText("其他支出", { exact: true })).toBeNull();
  expect(screen.queryByText("中介费", { exact: true })).toBeNull();
  expect(screen.getByText("资金账户", { exact: true })).toBeInTheDocument();
});

it("回收资金明细的大额支出合计保留分位", async () => {
  renderLight(<Form initialValues={{ recovery_price: "9999999999999999.98", expense_items: [{ amount: "0.01" }] }}>
    <FieldConfigContext.Provider value={{}}><RecoveryFeeSection pools={pools} /></FieldConfigContext.Provider>
  </Form>);
  expect(await screen.findByText("9,999,999,999,999,999.99")).toBeInTheDocument();
});

it("HS 费用卡片：增加支出入口锚定在蓝色主金额卡片内", () => {
  renderHs({});
  const card = document.querySelector(".finance-card-with-expense-action");
  expect(card).not.toBeNull();
  expect(card).toContainElement(screen.getByRole("button", { name: /增加支出/ }));
  expect(card).toHaveClass("finance-card-with-expense-action");
  expect(card).toHaveClass("finance-card-with-expense-action--reserved");
});

it("HS 回收金额拒绝负数和超过两位小数", async () => {
  const user = userEvent.setup();
  const onFinish = vi.fn();
  renderHsWithSubmit(onFinish);
  const input = screen.getByRole("textbox", { name: /回收金额/ });

  await user.type(input, "-1");
  await user.click(screen.getByRole("button", { name: "提交" }));
  expect(await screen.findByText("回收金额不能为负数")).toBeInTheDocument();
  expect(onFinish).not.toHaveBeenCalled();

  await user.clear(input);
  await user.type(input, "1.234");
  await user.click(screen.getByRole("button", { name: "提交" }));
  await waitFor(() => expect(screen.getByText("回收金额必须是数字，最多两位小数")).toBeInTheDocument());
  expect(onFinish).not.toHaveBeenCalled();
});
