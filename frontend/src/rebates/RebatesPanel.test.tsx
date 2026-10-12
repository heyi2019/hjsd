import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { RebatesPanel } from "./RebatesPanel";

const rebatesList = vi.fn();
const rebatesCreate = vi.fn();
const rebatesSettle = vi.fn();
const ordersList = vi.fn();
const poolsList = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  rebatesApi: {
    list: (...a: unknown[]) => rebatesList(...a),
    create: (...a: unknown[]) => rebatesCreate(...a),
    settle: (...a: unknown[]) => rebatesSettle(...a),
  },
  ordersApi: { list: (...a: unknown[]) => ordersList(...a), create: vi.fn() },
  poolsApi: { list: (...a: unknown[]) => poolsList(...a), create: vi.fn(), balance: vi.fn() },
}));

const rebates = [
  {
    id: 1,
    rebate_group_no: "REB-0001",
    source_order_id: 10,
    rate: "0.10",
    base_amount: "1000.00",
    status: "PENDING",
    collected_on: "2026-10-01",
  },
  {
    id: 2,
    rebate_group_no: "REB-0002",
    source_order_id: 10,
    rate: "0.05",
    base_amount: "2000.00",
    status: "SETTLED",
    collected_on: "2026-10-02",
  },
];
const orders = [
  { id: 10, order_no: "HS-2026-0010", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-01", status: "ACTIVE" },
  { id: 11, order_no: "HS-2026-0011", order_type: "HS", capital_type: "SELF", trade_date: "2026-10-03", status: "DRAFT" },
];
const pools = [{ id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" }];

beforeEach(() => {
  vi.clearAllMocks();
  rebatesList.mockResolvedValue(rebates);
  ordersList.mockResolvedValue(orders);
  poolsList.mockResolvedValue(pools);
});

async function pickSelect(modal: HTMLElement, index: number, title: RegExp) {
  await userEvent.click(modal.querySelectorAll(".ant-select-selector")[index] as Element);
  const dropdowns = document.querySelectorAll(".ant-select-dropdown");
  const current = dropdowns[dropdowns.length - 1] as HTMLElement;
  await userEvent.click(await within(current).findByTitle(title));
}

describe("RebatesPanel：返点归集列表", () => {
  it("渲染归集号、基数与费率", async () => {
    renderApp(<RebatesPanel />, { user: "admin" });
    expect(await screen.findByText("REB-0001")).toBeInTheDocument();
    expect(screen.getByText("REB-0002")).toBeInTheDocument();
    expect(screen.getAllByText("1,000.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("0.10").length).toBeGreaterThanOrEqual(1);
  });

  it("统计卡：待结算为计数口径，有未结算时给 warn 语气", async () => {
    renderApp(<RebatesPanel />, { user: "admin" });
    await screen.findByText("待结算");
    const card = screen.getAllByText("待结算").map((el) => el.closest(".ui-stat")).find(Boolean);
    expect(card?.textContent).toContain("1"); // REB-0001 PENDING
    expect(card?.className).toContain("ui-stat--warn");
  });

  it("已 SETTLED 的返点禁用「登记结算」", async () => {
    renderApp(<RebatesPanel />, { user: "admin" });
    await screen.findByText("REB-0001");
    const buttons = screen.getAllByRole("button", { name: /登记结算/ });
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false); // PENDING
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true); // SETTLED
  });

  it("后端不可达 → 错误条落地", async () => {
    rebatesList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<RebatesPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });
});

describe("RebatesPanel：新增归集 / 登记结算", () => {
  it("新增归集：来源订单只列 ACTIVE/COMPLETED（草稿订单不出现）", async () => {
    renderApp(<RebatesPanel />, { user: "admin" });
    await screen.findByText("REB-0001");
    await userEvent.click(screen.getByRole("button", { name: /新增归集/ }));
    await waitFor(() => expect(screen.getByText("新增返点归集")).toBeInTheDocument());
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await userEvent.click(modal.querySelector(".ant-select-selector") as Element);
    const dropdowns = document.querySelectorAll(".ant-select-dropdown");
    const options = [...(dropdowns[dropdowns.length - 1] as HTMLElement).querySelectorAll(
      ".ant-select-item-option",
    )].map((o) => o.getAttribute("title"));
    expect(options).toContain("HS-2026-0010");
    expect(options).not.toContain("HS-2026-0011"); // DRAFT
  });

  it("新增归集提交后回传基数字符串与归集日期", async () => {
    rebatesCreate.mockResolvedValueOnce({ id: 3 });
    renderApp(<RebatesPanel />, { user: "admin" });
    await screen.findByText("REB-0001");
    await userEvent.click(screen.getByRole("button", { name: /新增归集/ }));
    await waitFor(() => expect(screen.getByText("新增返点归集")).toBeInTheDocument());
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, /HS-2026-0010/);
    await userEvent.type(modal.querySelector("#base_amount") as Element, "1000.00");
    await userEvent.click(within(modal).getByRole("button", { name: /创\s*建/ }));
    await waitFor(() => expect(rebatesCreate).toHaveBeenCalled());
    const payload = rebatesCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.source_order_id).toBe(10);
    expect(payload.base_amount).toBe("1000.00");
    expect(payload.collected_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("登记结算提交后回传到账金额与回款池", async () => {
    rebatesSettle.mockResolvedValueOnce({ id: 9 });
    renderApp(<RebatesPanel />, { user: "admin" });
    await screen.findByText("REB-0001");
    await userEvent.click(screen.getAllByRole("button", { name: /登记结算/ })[0] as Element);
    await waitFor(() =>
      expect(document.querySelectorAll(".ant-modal-content").length).toBeGreaterThan(0),
    );
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await userEvent.type(modal.querySelector("#gross_amount") as Element, "880.00");
    await pickSelect(modal, 0, /POOL-A/);
    await userEvent.click(within(modal).getByRole("button", { name: /确认结算/ }));
    await waitFor(() => expect(rebatesSettle).toHaveBeenCalled());
    const [id, payload] = rebatesSettle.mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(1);
    expect(payload.gross_amount).toBe("880.00");
    expect(payload.pool_id).toBe(1);
  });

  it("viewer 无 order.event.post → 归集与结算入口不渲染", async () => {
    renderApp(<RebatesPanel />, { user: "viewer" });
    await screen.findByText("REB-0001");
    expect(screen.queryByRole("button", { name: /新增归集/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /登记结算/ })).toBeNull();
  });
});
