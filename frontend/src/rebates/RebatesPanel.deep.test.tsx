import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { RebatesPanel } from "./RebatesPanel";
import { resolveMockOnce } from "../test/mock-api";

import * as catalog from "../shared/api/catalog";
let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

vi.mock("../shared/api/catalog");

const orders = [
  { id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "SELF", status: "ACTIVE", account_business_mode: "SELF", account_game_type: "王者", account_game_account: "acc-x", party_name: "对手甲" },
  { id: 11, order_no: "HS-2026-0011", order_type: "TH", capital_type: "SELF", status: "COMPLETED", account_business_mode: "DISTRIBUTION", account_game_type: "", account_game_account: "", party_name: "" },
  { id: 12, order_no: "HS-2026-0012", order_type: "DG", capital_type: "SELF", status: "ACTIVE", account_business_mode: "", account_game_type: "", account_game_account: "", party_name: "" },
];
const pools = [{ id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" }];
const rebates = [
  { id: 1, rebate_no: "HS0001-RB01", source_order_id: 10, rebate_type: "BUY", rate: "0.10", base_amount: "1000.00", status: "PENDING", collected_on: "2026-10-01", expected_on: "2026-10-10" },
  { id: 2, rebate_no: "HS0001-RB02", source_order_id: 11, rebate_type: "SELL", rate: "0.05", base_amount: "2000.00", status: "SETTLED", collected_on: "2026-10-02", expected_on: "2026-10-20" },
  { id: 3, rebate_no: "HS0001-RB03", source_order_id: 12, rebate_type: "BUY", rate: "0.00", base_amount: "0.00", status: "PENDING", collected_on: "2026-10-03", expected_on: null },
];
const settlementsFor1 = [
  { id: 30, settlement_no: "ST-30", settled_on: "2026-10-05", gross_amount: "880.00", platform_fee: "20.00", net_amount: "860.00", status: "SETTLED", reversal_of_id: null },
  { id: 31, settlement_no: "ST-31", settled_on: "2026-10-06", gross_amount: "0.00", platform_fee: "0.00", net_amount: "0.00", status: "VOID", reversal_of_id: 30 },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.rebatesApi.list).mockResolvedValue(rebates as unknown as never);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue(orders as unknown as never);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue(pools as unknown as never);
  vi.mocked(catalog.rebatesApi.settlements).mockImplementation(
    (id: number) => Promise.resolve((id === 1 ? settlementsFor1 : []) as unknown as never),
  );
  vi.mocked(catalog.rebatesApi.overdue).mockResolvedValue([{ id: 1, overdue_days: 5 }] as unknown as never);
});

async function expandFirstRow() {
  const expand = document.querySelector(".ant-table-row-expand-icon") as HTMLElement;
  await ui.click(expand);
}

describe("RebatesPanel：结算明细 / 逾期 / 冲销 / 空态 / 错误重试", () => {
  it("列表列渲染业务模式、订单类型、产品与对方（load 成功分支）", async () => {
    renderLight(<RebatesPanel />, { user: "admin" });
    expect(await screen.findByText("HS0001-RB01")).toBeInTheDocument();
    expect(screen.getByText("对手甲")).toBeInTheDocument(); // 对方列
    expect(screen.getByText(/王者/)).toBeInTheDocument(); // 产品列
    expect(screen.getByText("自营")).toBeInTheDocument(); // BUSINESS_MODE_LABEL SELF
    expect(screen.getByText("分销")).toBeInTheDocument(); // BUSINESS_MODE_LABEL DISTRIBUTION
    expect(screen.getByText("回收")).toBeInTheDocument(); // orderTypeLabel HS
    // 预计到账：RB01 逾期红字、RB02 有日期未逾期、RB03 无日期
    expect(screen.getByText(/（逾期 5 天）/)).toBeInTheDocument();
    expect(screen.getByText("2026-10-20")).toBeInTheDocument();
    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(1); // RB03 无预计到账
  });

  it("展开行渲染结算明细：已结算与已冲销两种状态", async () => {
    renderLight(<RebatesPanel />, { user: "admin" });
    await screen.findByText("HS0001-RB01");
    await expandFirstRow();
    expect(await screen.findByText("ST-30")).toBeInTheDocument();
    expect(screen.getByText("ST-31")).toBeInTheDocument();
    expect(screen.getByText("已结算")).toBeInTheDocument();
    expect(screen.getByText("已冲销")).toBeInTheDocument();
    // 已冲销（ST-31, reversal_of_id=30）不渲染冲销按钮；已结算（ST-30）渲染一个
    expect(screen.getAllByRole("button", { name: /冲\s*销/ })).toHaveLength(1);
  });

  it("冲销已结算记录：提交后调用 reverseSettlement(rebateId, settlementId, payload)", async () => {
    resolveMockOnce(vi.mocked(catalog.rebatesApi.reverseSettlement), { id: 99 } as unknown as never);
    renderLight(<RebatesPanel />, { user: "admin" });
    await screen.findByText("HS0001-RB01");
    await expandFirstRow();
    await screen.findByText("ST-30");
    await ui.click(screen.getAllByRole("button", { name: /冲\s*销/ })[0]);
    const modal = await screen.findByRole("dialog");
    await ui.type(within(modal).getByLabelText("冲销日期"), "2026-10-08");
    await ui.type(within(modal).getByLabelText("冲销原因"), "录错账需冲正");
    await ui.click(within(modal).getByRole("button", { name: /确认冲销/ }));
    await waitFor(() => expect(vi.mocked(catalog.rebatesApi.reverseSettlement)).toHaveBeenCalled());
    const [rid, sid, payload] = vi.mocked(catalog.rebatesApi.reverseSettlement).mock.calls[0] as [number, number, Record<string, unknown>];
    expect(rid).toBe(1);
    expect(sid).toBe(30);
    expect(payload).toMatchObject({ reversed_on: expect.any(String), reason: "录错账需冲正" });
  });

  it("空列表：统计卡归零且表格空态", async () => {
    vi.mocked(catalog.rebatesApi.list).mockResolvedValue([] as unknown as never);
    renderLight(<RebatesPanel />, { user: "admin" });
    expect(await screen.findByText("暂无返点记录")).toBeInTheDocument();
    // 待结算 = 0、到账逾期 = 0（两个统计卡都显示 0）
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(2);
  });

  it("加载失败显示错误条，点「重新加载」可重试成功", async () => {
    vi.mocked(catalog.rebatesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" } as unknown as never);
    renderLight(<RebatesPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ui-error-banner")).toBeTruthy());
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    expect(await screen.findByText("HS0001-RB01")).toBeInTheDocument();
  });
});
