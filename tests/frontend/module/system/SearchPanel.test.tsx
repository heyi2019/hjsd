import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { SearchPanel } from "@/search/SearchPanel";
import { searchApi } from "@/shared/api/orders.api";
import type { SearchResult } from "@/shared/api/types/common";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/quality.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

const results: SearchResult[] = [
  { id: 1, type: "order", code: "HS-001", title: "订单", subtitle: "备注", route: "/orders/HS-001" },
];

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(searchApi.query).mockResolvedValue({ items: results });
});

describe("SearchPanel：全局搜索", () => {
  it("空关键词只给警告不发起请求", async () => {
    renderLight(<SearchPanel />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: /搜索/ }));
    expect(searchApi.query).not.toHaveBeenCalled();
  });

  it("输入关键词后展示结果", async () => {
    renderLight(<SearchPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText(/订单号/), "HS");
    await ui.click(screen.getByRole("button", { name: /搜索/ }));
    expect(await screen.findByText("HS-001")).toBeInTheDocument();
    await waitFor(() => expect(searchApi.query).toHaveBeenCalledWith("HS"));
  });

  it("FE-164：结果入口是可访问链接", async () => {
    renderLight(<SearchPanel />, { user: "admin" });
    const input = screen.getByPlaceholderText(/订单号/);
    await ui.type(input, "HS");
    await ui.click(screen.getByRole("button", { name: /搜索/ }));
    expect(await screen.findByRole("link", { name: /打开订单/ })).toHaveAttribute("href", "/orders/HS-001");
  });

  it("FE-198：清空关键词后清理旧结果", async () => {
    renderLight(<SearchPanel />, { user: "admin" });
    const input = screen.getByPlaceholderText(/订单号/);
    await ui.type(input, "HS");
    await ui.click(screen.getByRole("button", { name: /搜索/ }));
    expect(await screen.findByText("HS-001")).toBeInTheDocument();
    await ui.clear(input);
    await ui.click(screen.getByRole("button", { name: /搜索/ }));
    expect(screen.queryByText("HS-001")).not.toBeInTheDocument();
    expect(searchApi.query).toHaveBeenCalledTimes(1);
  });

  it("查询失败展示错误横幅", async () => {
    vi.mocked(searchApi.query).mockRejectedValue(new Error("search failed"));
    renderLight(<SearchPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText(/订单号/), "HS");
    await ui.click(screen.getByRole("button", { name: /搜索/ }));
    expect(await screen.findByText(/search failed/)).toBeInTheDocument();
  });
});
