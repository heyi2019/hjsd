import { render, screen } from "@testing-library/react";
import { Form } from "antd";
import type { ReactElement } from "react";
import type { Pool, OrderFormField } from "../../shared/api/catalog";
import { renderLight } from "../../test/render";
import { FieldConfigContext, type FieldConfigMap } from "../ConfigurableField";
import { ThFeeSection } from "./ThFeeSection";

const makeField = (over: Partial<OrderFormField> = {}): OrderFormField => ({
  id: 1,
  order_type_code: "TH",
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

function renderTh(cfg: FieldConfigMap) {
  return renderLight(
    <Form>
      <FieldConfigContext.Provider value={cfg}>
        <ThFeeSection pools={pools} />
      </FieldConfigContext.Provider>
    </Form>,
  );
}

it("TH 费用卡片：账号号价/预计收买家标题跟随配置改名", () => {
  renderTh({
    th_purchase_amount: makeField({ field_key: "th_purchase_amount", label: "提号成本", field_type: "NUMBER", required: true }),
    th_receive_amount: makeField({ field_key: "th_receive_amount", label: "预计收买价", field_type: "NUMBER", required: true }),
  });
  expect(screen.getByText("提号成本")).toBeInTheDocument();
  expect(screen.getByText("预计收买价")).toBeInTheDocument();
});

it("TH 费用卡片：无配置时降级显示原硬编码标题", () => {
  renderTh({});
  expect(screen.getByText("账号号价")).toBeInTheDocument();
  expect(screen.getByText("预计收买家")).toBeInTheDocument();
});

it("TH 费用卡片：资金账户标题使用系统统一术语，不受配置旧文案影响", () => {
  renderTh({
    payment_pool_id: makeField({ field_key: "payment_pool_id", label: "资金出处", required: true }),
  });
  expect(screen.getByText("资金账户")).toBeInTheDocument();
});
