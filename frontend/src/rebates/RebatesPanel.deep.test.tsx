import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { RebatesPanel } from "./RebatesPanel";
import { resolveMockOnce } from "../test/mock-api";

import * as catalog from "../shared/api/catalog";
import { seedOrderFormFields } from "../test/formFieldsSeed";
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
  { id: 1, rebate_no: "HS0001-RB01", source_order_id: 10, rebate_type: "BUY", rate: "0.10", base_amount: "1000.00", status: "PENDING", collected_on: "2026-10-01" },
  { id: 2, rebate_no: "HS0001-RB02", source_order_id: 11, rebate_type: "SELL", rate: "0.05", base_amount: "2000.00", status: "SETTLED", collected_on: "2026-10-02" },
  { id: 3, rebate_no: "HS0001-RB03", source_order_id: 12, rebate_type: "BUY", rate: "0.00", base_amount: "0.00", status: "PENDING", collected_on: "2026-10-03" },
];
beforeEach(() => {
  vi.clearAllMocks();
  seedOrderFormFields(catalog);
  vi.mocked(catalog.rebatesApi.list).mockResolvedValue(rebates as unknown as never);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue(orders as unknown as never);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue(pools as unknown as never);
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([] as unknown as never);
});

async function expandFirstRow() {
  const expand = document.querySelector(".ant-table-row-expand-icon") as HTMLElement;
  await ui.click(expand);
}

describe("RebatesPanel：返点明细 / 空态 / 错误重试", () => {
  it("列表列渲染业务模式、订单类型、产品与对方（load 成功分支）", async () => {
    renderLight(<RebatesPanel />, { user: "admin" });
    expect(await screen.findByText("HS0001-RB01")).toBeInTheDocument();
    expect(screen.getByText("对手甲")).toBeInTheDocument(); // 对方列
    expect(screen.getByText(/王者/)).toBeInTheDocument(); // 产品列
    expect(screen.getByText("自营")).toBeInTheDocument(); // BUSINESS_MODE_LABEL SELF
    expect(screen.getByText("分销")).toBeInTheDocument(); // BUSINESS_MODE_LABEL DISTRIBUTION
    expect(screen.getByText("回收")).toBeInTheDocument(); // orderTypeLabel HS
    expect(screen.queryByText("预计到账")).toBeNull();
    expect(screen.queryByText("到账逾期")).toBeNull();
  });

  it("空列表：统计卡归零且表格空态", async () => {
    vi.mocked(catalog.rebatesApi.list).mockResolvedValue([] as unknown as never);
    renderLight(<RebatesPanel />, { user: "admin" });
    expect(await screen.findByText("暂无返点记录")).toBeInTheDocument();
    // 返点页面不提供结算、冲销或作废状态。
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(1);
  });

  it("加载失败显示错误条，点「重新加载」可重试成功", async () => {
    vi.mocked(catalog.rebatesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" } as unknown as never);
    renderLight(<RebatesPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ui-error-banner")).toBeTruthy());
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    expect(await screen.findByText("HS0001-RB01")).toBeInTheDocument();
  });

  it("返点列表只提供编辑和删除，不提供结算、冲销或作废", async () => {
    renderLight(<RebatesPanel />, { user: "admin" });
    expect(await screen.findByText("HS0001-RB01")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /登记结算/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /冲销/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /作废/ })).toBeNull();
  });
});
