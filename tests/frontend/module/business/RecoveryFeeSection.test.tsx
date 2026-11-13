import { render, screen } from "@testing-library/react";
import { Form } from "antd";
import type { ReactElement } from "react";
import type { Pool } from "@/shared/api/types/finance";
import type { OrderFormField } from "@/shared/api/types/forms";
import { renderLight } from "@fixtures/render";
import { FieldConfigContext, type FieldConfigMap } from "@/orders/ConfigurableField";
import { RecoveryFeeSection } from "@/orders/recovery/RecoveryFeeSection";

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
        <RecoveryFeeSection totalRecoveryCost="0.00" pools={pools} />
      </FieldConfigContext.Provider>
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
  expect(screen.getByRole("button", { name: /增加支出/ })).toBeInTheDocument();
  expect(screen.queryByText("其他支出", { exact: true })).toBeNull();
  expect(screen.queryByText("中介费", { exact: true })).toBeNull();
  expect(screen.getByText("资金账户", { exact: true })).toBeInTheDocument();
});
