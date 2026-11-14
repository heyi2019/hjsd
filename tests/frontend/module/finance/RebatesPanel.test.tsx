import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { RebatesPanel } from "@/rebates/RebatesPanel";
import { resolveMockOnce } from "@fixtures/mock-api";

import { ordersApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";
import { rebatesApi } from "@/shared/api/rebates.api";
import { seedOrderFormFields } from "@fixtures/formFieldsSeed";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");

const rebates = [
  {
    id: 1,
    rebate_no: "HS0001-RB01",
    source_order_id: 10,
    rebate_type: "BUY",
    rate: "0.10",
    base_amount: "1000.00",
    status: "SETTLED",
    collected_on: "2026-10-01",
    already_returned: "400.00",
    remaining: "600.00",
  },
  {
    id: 2,
    rebate_no: "HS0001-RB02",
    source_order_id: 10,
    rebate_type: "SELL",
    rate: "0.05",
    base_amount: "2000.00",
    status: "SETTLED",
    collected_on: "2026-10-02",
    already_returned: "0.00",
    remaining: "2000.00",
  },
];
const orders = [
  { id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" },
  { id: 11, order_no: "HS-2026-0011", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-03", status: "CANCELLED" },
];
const pools = [{ id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" }];

beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields();
  vi.mocked(rebatesApi.list).mockResolvedValue(rebates);
  vi.mocked(ordersApi.list).mockResolvedValue(orders);
  vi.mocked(poolsApi.list).mockResolvedValue(pools);
  vi.mocked(employeesApi.list).mockResolvedValue([]);
});

async function pickSelect(modal: HTMLElement, index: number, title: RegExp) {
  await ui.click(modal.querySelectorAll(".ant-select-selector")[index] as Element);
  const dropdowns = document.querySelectorAll(".ant-select-dropdown");
  const current = dropdowns[dropdowns.length - 1] as HTMLElement;
  await ui.click(await within(current).findByTitle(title));
}

describe("RebatesPanel：返点记录列表", () => {
  it("渲染返点单号、基数与费率", async () => {
    renderLight(<RebatesPanel />, { user: "admin" });
    expect(await screen.findByText("HS0001-RB01")).toBeInTheDocument();
    expect(screen.getByText("HS0001-RB02")).toBeInTheDocument();
    expect(screen.getAllByText("1,000.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("0.10%").length).toBeGreaterThanOrEqual(1);
  });

  it("可退余额取后端下发值，不在前端自行相减", async () => {
    renderLight(<RebatesPanel />, { user: "admin" });
    await screen.findByText("HS0001-RB01");
    expect(screen.getAllByText("可退余额").length).toBeGreaterThanOrEqual(1);
    // RB01 后端下发 remaining=600.00（而非 base 1000），证明直接消费后端口径。
    expect(screen.getAllByText("600.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("2,000.00").length).toBeGreaterThanOrEqual(1);
  });

  it("统计卡：返点记录数正常展示", async () => {
    renderLight(<RebatesPanel />, { user: "admin" });
    expect(await screen.findByText("返点记录数")).toBeInTheDocument();
    expect(screen.queryByText("待结算")).toBeNull();
    expect(screen.queryByRole("button", { name: /登记结算/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /冲销/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /取消/ })).toBeNull();
  });

  it("后端不可达 → 错误条落地", async () => {
    vi.mocked(rebatesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<RebatesPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("来源订单为空时禁用新增返点记录入口", async () => {
    vi.mocked(ordersApi.list).mockResolvedValue([]);
    renderLight(<RebatesPanel />, { user: "admin" });
    const addBtn = await screen.findByRole("button", { name: /新增返点记录/ });
    await waitFor(() => expect(addBtn).toBeDisabled());
  });

  it("FE-231：返点数据失败时统计不可用并禁用新增", async () => {
    vi.mocked(rebatesApi.list).mockRejectedValueOnce(new Error("rebates down"));
    renderLight(<RebatesPanel />, { user: "admin" });
    expect(await screen.findByText("返点明细")).toBeInTheDocument();
    expect(screen.getByText("返点记录数").closest(".ui-stat")).toHaveTextContent("不可用");
    expect(screen.getByRole("button", { name: /新增返点记录/ })).toBeDisabled();
  });
});

describe("RebatesPanel：新增返点记录 / 登记到账", () => {
  it("新增返点记录：来源订单只列 ACTIVE/COMPLETED（非 ACTIVE/COMPLETED 态不出现）", async () => {
    renderLight(<RebatesPanel />, { user: "admin" });
    await screen.findByText("HS0001-RB01");
    await ui.click(screen.getByRole("button", { name: /新增返点记录/ }));
    await waitFor(() => expect(screen.getAllByText("新增返点记录").length).toBeGreaterThan(0));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await ui.click(modal.querySelector(".ant-select-selector") as Element);
    const dropdowns = document.querySelectorAll(".ant-select-dropdown");
    const options = [...(dropdowns[dropdowns.length - 1] as HTMLElement).querySelectorAll(
      ".ant-select-item-option",
    )].map((o) => o.getAttribute("title"));
    expect(options).toContain("HS-2026-0010");
    expect(options).not.toContain("HS-2026-0011"); // CANCELLED
  });

  it("新增返点记录提交后回传基数字符串与返点日期", async () => {
    resolveMockOnce(vi.mocked(rebatesApi.create), { id: 3 });
    renderLight(<RebatesPanel />, { user: "admin" });
    await screen.findByText("HS0001-RB01");
    await ui.click(screen.getByRole("button", { name: /新增返点记录/ }));
    await waitFor(() => expect(screen.getAllByText("新增返点记录").length).toBeGreaterThan(0));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, /HS-2026-0010/);
    await ui.type(modal.querySelector("#base_amount") as Element, "1000.00");
    await ui.click(within(modal).getByRole("button", { name: /创\s*建/ }));
    await waitFor(() => expect(vi.mocked(rebatesApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(rebatesApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.source_order_id).toBe(10);
    expect(payload.base_amount).toBe("1000.00");
    expect(payload.collected_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("viewer 无 order.event.post → 返点与到账入口不渲染", async () => {
    renderLight(<RebatesPanel />, { user: "viewer" });
    await screen.findByText("HS0001-RB01");
    expect(screen.queryByRole("button", { name: /新增返点记录/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /登记结算/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /退回/ })).toBeNull();
  });

});

describe("RebatesPanel：返点退回（REB-01）", () => {
  beforeEach(() => {
    vi.mocked(rebatesApi.returnRebate).mockResolvedValue({
      rebate: { ...rebates[0], already_returned: "600.00", remaining: "400.00" },
      cashflow: {
        id: 9, flow_no: "ZC00009", pool_id: 1, occurred_on: "2026-11-12",
        nature: "BUSINESS_OUT", fund_nature: "BUSINESS", accounting_attribute: "REVERSAL",
        category: "REBATE_REVERSAL", direction: "OUT", amount: "200.00", status: "APPROVED",
        source: "REBATE_SETTLEMENT",
      },
      already_returned: "600.00", remaining: "400.00",
    } as never);
  });

  it("每行渲染退回入口，但历史 VOID / 可退余额为 0 时禁用", async () => {
    vi.mocked(rebatesApi.list).mockResolvedValueOnce([
      ...rebates,
      { ...rebates[1], id: 3, rebate_no: "HS0001-RB03", status: "VOID", remaining: "2000.00" },
      { ...rebates[1], id: 4, rebate_no: "HS0001-RB04", status: "SETTLED", remaining: "0.00" },
    ]);
    renderLight(<RebatesPanel />, { user: "admin" });
    await screen.findByText("HS0001-RB01");
    const returnButtons = screen.getAllByRole("button", { name: "退回" });
    expect(returnButtons.length).toBe(4);
    // RB01 可退 600 → 可点；RB03 VOID、RB04 余额 0 → 禁用。
    expect(returnButtons[0]).not.toBeDisabled();
    expect(returnButtons[2]).toBeDisabled();
    expect(returnButtons[3]).toBeDisabled();
  });

  it("提交退回回传金额与真实退回日，成功后刷新列表", async () => {
    renderLight(<RebatesPanel />, { user: "admin" });
    await screen.findByText("HS0001-RB01");
    await ui.click(screen.getAllByRole("button", { name: "退回" })[0]);
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    expect((await within(modal).findAllByText(/可退余额/)).length).toBeGreaterThanOrEqual(1);
    await ui.type(modal.querySelector("#amount") as Element, "200.00");
    await ui.click(within(modal).getByRole("button", { name: /确认退回/ }));
    await waitFor(() => expect(vi.mocked(rebatesApi.returnRebate)).toHaveBeenCalled());
    const payload = vi.mocked(rebatesApi.returnRebate).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.amount).toBe("200.00");
    expect(payload.returned_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await waitFor(() => expect(vi.mocked(rebatesApi.list).mock.calls.length).toBeGreaterThan(1));
  });

  it("超额退回在前端即时拦截，不发起请求", async () => {
    renderLight(<RebatesPanel />, { user: "admin" });
    await screen.findByText("HS0001-RB01");
    await ui.click(screen.getAllByRole("button", { name: "退回" })[0]);
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await ui.type(modal.querySelector("#amount") as Element, "700.00"); // > 可退 600
    await ui.click(within(modal).getByRole("button", { name: /确认退回/ }));
    await waitFor(() => expect(within(modal).getByText(/不得超过可退余额/)).toBeInTheDocument());
    expect(vi.mocked(rebatesApi.returnRebate)).not.toHaveBeenCalled();
  });
});
