import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { InventoryPanel } from "./InventoryPanel";

const accountsList = vi.fn();
const accountsCreate = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  accountsApi: {
    list: (...a: unknown[]) => accountsList(...a),
    create: (...a: unknown[]) => accountsCreate(...a),
  },
}));

const accounts = [
  { id: 1, account_no: "HJACC-0001", game_account: "acc-1", platform: "A平台", status: "IN_STOCK", cost_amount: "100.00" },
  { id: 2, account_no: "HJACC-0002", game_account: "acc-2", platform: "B平台", status: "SOLD", cost_amount: "200.00" },
];

beforeEach(() => {
  vi.clearAllMocks();
  accountsList.mockResolvedValue(accounts);
});

describe("InventoryPanel：账号台账", () => {
  it("渲染账号编号、标识与状态标签", async () => {
    renderApp(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByText("HJACC-0001")).toBeInTheDocument();
    expect(screen.getByText("HJACC-0002")).toBeInTheDocument();
    expect(screen.getAllByText("在库").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("已售").length).toBeGreaterThanOrEqual(1);
  });

  it("统计卡：在库/分期中为计数，占用成本为金额（只统计在库+分期中）", async () => {
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("在库 / 分期中");
    const occupied = screen.getByText("在库 / 分期中").closest(".ui-stat");
    expect(occupied?.textContent).toContain("1");
    const cost = screen.getByText("占用成本合计").closest(".ui-stat");
    expect(cost?.textContent).toContain("100.00"); // 只算 IN_STOCK 的 100，SOLD 的 200 不计
    // 「已售」同时是统计卡 label 与状态标签 → 只在统计卡容器里找
    const sold = screen
      .getAllByText("已售")
      .map((el) => el.closest(".ui-stat"))
      .find(Boolean);
    expect(sold?.textContent).toContain("1");
  });

  it("后端不可达 → 错误条落地", async () => {
    accountsList.mockRejectedValueOnce({ isAxiosError: true, message: "Network Error" });
    renderApp(<InventoryPanel />, { user: "admin" });
    await waitFor(() => expect(document.querySelector(".ant-alert")).toBeTruthy());
  });

  it("无数据时显示「暂无账号」", async () => {
    accountsList.mockResolvedValueOnce([]);
    renderApp(<InventoryPanel />, { user: "admin" });
    expect(await screen.findByText("暂无账号")).toBeInTheDocument();
  });
});

describe("InventoryPanel：建档写路径", () => {
  it("提交后回传账号标识与平台", async () => {
    accountsCreate.mockResolvedValueOnce({ id: 3 });
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("HJACC-0001");
    await userEvent.type(screen.getByPlaceholderText("账号标识"), "acc-3");
    await userEvent.type(screen.getByPlaceholderText("平台"), "C平台");
    await userEvent.click(screen.getByRole("button", { name: /建\s*档/ }));
    await waitFor(() => expect(accountsCreate).toHaveBeenCalled());
    expect(accountsCreate.mock.calls[0][0]).toMatchObject({ game_account: "acc-3", platform: "C平台" });
  });

  it("账号标识必填：空提交被拦下", async () => {
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("HJACC-0001");
    await userEvent.click(screen.getByRole("button", { name: /建\s*档/ }));
    expect(await screen.findByText("账号标识必填")).toBeInTheDocument();
    expect(accountsCreate).not.toHaveBeenCalled();
  });

  it("建档失败时错误落到 ErrorBanner", async () => {
    accountsCreate.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "VALIDATION_ERROR", message: "账号标识重复" } },
      message: "Request failed",
    });
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("HJACC-0001");
    await userEvent.type(screen.getByPlaceholderText("账号标识"), "dup");
    await userEvent.click(screen.getByRole("button", { name: /建\s*档/ }));
    expect(await screen.findByText(/必填项与格式/)).toBeInTheDocument();
  });

  it("viewer 无 order.create → 建档按钮不渲染", async () => {
    renderApp(<InventoryPanel />, { user: "viewer" });
    await screen.findByText("HJACC-0001");
    expect(screen.queryByRole("button", { name: /建\s*档/ })).toBeNull();
  });
});

describe("InventoryPanel：状态筛选", () => {
  it("按状态筛选时把 status 传给后端，而非前端过滤", async () => {
    renderApp(<InventoryPanel />, { user: "admin" });
    await screen.findByText("HJACC-0001");
    await userEvent.click(document.querySelector(".ant-select-selector") as Element);
    const dropdowns = document.querySelectorAll(".ant-select-dropdown");
    const option = await waitFor(() => {
      const found = [...(dropdowns[dropdowns.length - 1] as HTMLElement).querySelectorAll(
        ".ant-select-item-option",
      )].find((o) => /在库/.test(o.getAttribute("title") ?? o.textContent ?? ""));
      if (!found) throw new Error("option not ready");
      return found as Element;
    });
    await userEvent.click(option);
    await waitFor(() =>
      expect(accountsList.mock.calls.some((c) => (c[0] as { status?: string })?.status === "IN_STOCK")).toBe(
        true,
      ),
    );
  });
});
