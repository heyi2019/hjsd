import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../shared/api/catalog";
import { renderLight } from "../test/render";
import { InventoryConsignmentModal } from "./InventoryConsignmentModal";

import * as catalog from "../shared/api/catalog";

vi.mock("../shared/api/catalog");

const account = {
  id: 1,
  source_order_no: "DG-2026-0003",
  game_account: "acc-3",
  game_type: "手游",
  status: "IN_STOCK",
} as unknown as Account;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("InventoryConsignmentModal 已上架记录平台展示（L234）", () => {
  it("DG 订单已保存 consignment_platform 时，已上架记录展示平台名而非空", async () => {
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [
        {
          order_id: 22,
          order_type: "DG",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          extra_values: { consignment_platform: "盼之", listed_at: "2026-10-12T09:10:00" },
        },
      ],
    } as never);

    renderLight(
      <InventoryConsignmentModal account={account} onClose={vi.fn()} onCreated={vi.fn()} />,
      { user: "admin" },
    );

    // “已上架记录”区块已渲染
    expect(screen.getByText("已上架记录")).toBeInTheDocument();
    // 平台名（而非空 / “-”）出现在已上架记录表格
    expect(await screen.findByText("盼之")).toBeInTheDocument();
  });

  it("DG 订单无 consignment_platform 时，从 counterparties(PLATFORM) 兜底展示平台名，不再为空", async () => {
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "IN_STOCK" },
      orders: [
        {
          order_id: 22,
          order_type: "DG",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          counterparties: [{ id: 11, display_name: "寄售平台A", role: "PLATFORM" }],
        },
      ],
    } as never);

    renderLight(
      <InventoryConsignmentModal account={account} onClose={vi.fn()} onCreated={vi.fn()} />,
      { user: "admin" },
    );

    expect(await screen.findByText("寄售平台A")).toBeInTheDocument();
  });

  it("账号处于 VOID 时，已上架记录为空且无旧平台残留", async () => {
    vi.mocked(catalog.stocksApi.executionDetail).mockResolvedValue({
      account: { id: 1, status: "VOID" },
      orders: [
        {
          order_id: 22,
          order_type: "DG",
          status: "ACTIVE",
          trade_date: "2026-10-12",
          created_at: "2026-10-12T09:10:00",
          counterparties: [{ id: 11, display_name: "寄售平台A", role: "PLATFORM" }],
        },
      ],
    } as never);

    renderLight(
      <InventoryConsignmentModal account={account} onClose={vi.fn()} onCreated={vi.fn()} />,
      { user: "admin" },
    );

    expect(await screen.findByText("已上架记录")).toBeInTheDocument();
    // VOID 账号按源码逻辑清空列表；不得渲染平台名
    await waitFor(() => expect(screen.queryByText("寄售平台A")).not.toBeInTheDocument());
  });
});
