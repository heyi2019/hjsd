import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { ThBusinessPanel } from "@/orders/th/ThBusinessPanel";
import { ThFeeSection } from "@/orders/th/ThFeeSection";
import { Form } from "antd";
import { FieldConfigContext, type FieldConfigMap } from "@/orders/ConfigurableField";
import * as catalog from "@/shared/api/catalog";
import type { Order, OrderFormField, Pool } from "@/shared/api/catalog";

vi.mock("@/shared/api/catalog");

const orders: Order[] = [
  { id: 1, order_no: "TH-001", order_type: "TH", trade_date: "2026-10-01", status: "ACTIVE", note: null } as unknown as Order,
  { id: 2, order_no: "HS-001", order_type: "HS", trade_date: "2026-10-02", status: "ACTIVE", note: null } as unknown as Order,
];

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(catalog.ordersApi.list).mockResolvedValue(orders);
});

describe("ThBusinessPanel：分销·提号", () => {
  it("仅展示提号(TH)订单", async () => {
    renderLight(<ThBusinessPanel />, { user: "admin" });
    expect(await screen.findByText("TH-001")).toBeInTheDocument();
    expect(screen.queryByText("HS-001")).not.toBeInTheDocument();
  });

  it("加载失败展示错误横幅", async () => {
    vi.mocked(catalog.ordersApi.list).mockRejectedValue(new Error("orders down"));
    renderLight(<ThBusinessPanel />, { user: "admin" });
    expect(await screen.findByText(/orders down/)).toBeInTheDocument();
  });

  it("点击新建提号打开创建弹窗", async () => {
    renderLight(<ThBusinessPanel />, { user: "admin" });
    await screen.findByText("TH-001");
    await ui.click(screen.getByRole("button", { name: /新建提号/ }));
    // CreateBusinessModal 按 initialOrderType=TH 渲染标题「新建提号订单」
    await waitFor(() => expect(screen.getByText("新建提号订单")).toBeInTheDocument());
  });
});

// —— 原 ThFeeSection.test.tsx ——
// 费用卡片标题的配置化与回退：ThFeeSection 只吃 props + FieldConfigContext，无网络依赖。
describe("ThFeeSection：费用卡片标题", () => {
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

  it("TH 费用卡片：提号金额/预计收买家标题跟随配置改名", () => {
    renderTh({
      th_purchase_amount: makeField({ field_key: "th_purchase_amount", label: "提号成本", field_type: "NUMBER", required: true }),
      th_receive_amount: makeField({ field_key: "th_receive_amount", label: "预计收买价", field_type: "NUMBER", required: true }),
    });
    expect(screen.getByText("提号成本")).toBeInTheDocument();
    expect(screen.getByText("预计收买价")).toBeInTheDocument();
  });

  it("TH 费用卡片：无配置时降级显示原硬编码标题", () => {
    renderTh({});
    expect(screen.getByText("提号金额")).toBeInTheDocument();
    expect(screen.getByText("预计收买家")).toBeInTheDocument();
  });

  it("TH 费用卡片：资金账户标题使用系统统一术语，不受配置旧文案影响", () => {
    renderTh({
      payment_pool_id: makeField({ field_key: "payment_pool_id", label: "资金出处", required: true }),
    });
    expect(screen.getByText("资金账户")).toBeInTheDocument();
  });
});
