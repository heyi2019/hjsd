import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLight } from "@fixtures/render";
import { ThFeeSection } from "@/orders/th/ThFeeSection";
import { Form } from "antd";
import { FieldConfigContext, type FieldConfigMap } from "@/orders/ConfigurableField";
import type { Pool } from "@/shared/api/types/finance";
import type { OrderFormField } from "@/shared/api/types/forms";

const pools: Pool[] = [];

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

function renderTh(cfg: FieldConfigMap) {
  return renderLight(
    <Form>
      <FieldConfigContext.Provider value={cfg}>
        <ThFeeSection pools={pools} />
      </FieldConfigContext.Provider>
    </Form>,
  );
}

describe("ThFeeSection：费用卡片标题", () => {
  it("TH 费用卡片：提号金额标题跟随配置改名且移除预计收买家", () => {
    renderTh({
      th_purchase_amount: makeField({ field_key: "th_purchase_amount", label: "提号成本", field_type: "NUMBER", required: true }),
    });
    expect(screen.getByText("提号成本")).toBeInTheDocument();
    expect(screen.queryByText("预计收买家")).toBeNull();
  });

  it("TH 费用卡片：无配置时降级显示原硬编码标题", () => {
    renderTh({});
    expect(screen.getByText("提号金额")).toBeInTheDocument();
    expect(screen.queryByText("预计收买家")).toBeNull();
  });

  it("TH 费用卡片：资金账户标题使用系统统一术语，不受配置旧文案影响", () => {
    renderTh({
      payment_pool_id: makeField({ field_key: "payment_pool_id", label: "资金出处", required: true }),
    });
    expect(screen.getByText("资金账户")).toBeInTheDocument();
  });

});
