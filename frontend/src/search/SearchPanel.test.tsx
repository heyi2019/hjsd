import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { SearchPanel } from "./SearchPanel";
import * as catalog from "../shared/api/catalog";
import type { SearchResult } from "../shared/api/catalog";

vi.mock("../shared/api/catalog");

const results: SearchResult[] = [
  { id: 1, type: "order", code: "HS-001", title: "订单", subtitle: "备注", route: "/orders/HS-001" },
];

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(catalog.searchApi.query).mockResolvedValue({ items: results });
});

describe("SearchPanel：全局搜索", () => {
  it("空关键词只给警告不发起请求", async () => {
    renderLight(<SearchPanel />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: /搜索/ }));
    expect(catalog.searchApi.query).not.toHaveBeenCalled();
  });

  it("输入关键词后展示结果", async () => {
    renderLight(<SearchPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText(/订单号/), "HS");
    await ui.click(screen.getByRole("button", { name: /搜索/ }));
    expect(await screen.findByText("HS-001")).toBeInTheDocument();
    await waitFor(() => expect(catalog.searchApi.query).toHaveBeenCalledWith("HS"));
  });

  it("查询失败展示错误横幅", async () => {
    vi.mocked(catalog.searchApi.query).mockRejectedValue(new Error("search failed"));
    renderLight(<SearchPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText(/订单号/), "HS");
    await ui.click(screen.getByRole("button", { name: /搜索/ }));
    expect(await screen.findByText(/search failed/)).toBeInTheDocument();
  });
});
