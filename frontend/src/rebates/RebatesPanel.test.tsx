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

vi.mock("../shared/api/catalog")

const rebates = [
  {
    id: 1,
    rebate_no: "HS0001-RB01",
    source_order_id: 10,
    rebate_type: "BUY",
    rate: "0.10",
    base_amount: "1000.00",
    status: "PENDING",
    collected_on: "2026-10-01",
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
  },
];
const orders = [
  { id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" },
  { id: 11, order_no: "HS-2026-0011", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-03", status: "CANCELLED" },
];
const pools = [{ id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.rebatesApi.list).mockResolvedValue(rebates);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue(orders);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue(pools);
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

  it("统计卡：待结算为计数口径，有未结算时给 warn 语气", async () => {
    renderLight(<RebatesPanel />, { user: "admin" });
    await screen.findByText("待结算");
    const card = screen.getAllByText("待结算").map((el) => el.closest(".ui-stat")).find(Boolean);
    expect(card?.textContent).toContain("1"); // HS0001-RB01 PENDING
    expect(card?.className).toContain("ui-stat--warn");
  });

  it("已 SETTLED 的返点禁用「登记结算」", async () => {
    renderLight(<RebatesPanel />, { user: "admin" });
    await screen.findByText("HS0001-RB01");
    const buttons = screen.getAllByRole("button", { name: /登记结算/ });
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false); // PENDING
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true); // SETTLED
  });

  it("后端不可达 → 错误条落地", async () => {
    vi.mocked(catalog.rebatesApi.list).mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderLight(<RebatesPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
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
    resolveMockOnce(vi.mocked(catalog.rebatesApi.create), { id: 3 });
    renderLight(<RebatesPanel />, { user: "admin" });
    await screen.findByText("HS0001-RB01");
    await ui.click(screen.getByRole("button", { name: /新增返点记录/ }));
    await waitFor(() => expect(screen.getAllByText("新增返点记录").length).toBeGreaterThan(0));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, /HS-2026-0010/);
    await ui.type(modal.querySelector("#base_amount") as Element, "1000.00");
    await ui.click(within(modal).getByRole("button", { name: /创\s*建/ }));
    await waitFor(() => expect(vi.mocked(catalog.rebatesApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(catalog.rebatesApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.source_order_id).toBe(10);
    expect(payload.base_amount).toBe("1000.00");
    expect(payload.collected_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("登记结算提交后回传到账金额与回款池", async () => {
    resolveMockOnce(vi.mocked(catalog.rebatesApi.settle), { id: 9 });
    renderLight(<RebatesPanel />, { user: "admin" });
    await screen.findByText("HS0001-RB01");
    await ui.click(screen.getAllByRole("button", { name: /登记结算/ })[0] as Element);
    await waitFor(() =>
      expect(document.querySelectorAll(".ant-modal-content").length).toBeGreaterThan(0),
    );
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await ui.type(modal.querySelector("#gross_amount") as Element, "880.00");
    await pickSelect(modal, 0, /POOL-A/);
    await ui.click(within(modal).getByRole("button", { name: /确认结算/ }));
    await waitFor(() => expect(vi.mocked(catalog.rebatesApi.settle)).toHaveBeenCalled());
    const [id, payload] = vi.mocked(catalog.rebatesApi.settle).mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(1);
    expect(payload.gross_amount).toBe("880.00");
    expect(payload.pool_id).toBe(1);
  });

  it("viewer 无 order.event.post → 返点与到账入口不渲染", async () => {
    renderLight(<RebatesPanel />, { user: "viewer" });
    await screen.findByText("HS0001-RB01");
    expect(screen.queryByRole("button", { name: /新增返点记录/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /登记结算/ })).toBeNull();
  });
});
