import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/shared/api/client", () => ({ api: apiMock }));

import { stocksApi } from "@/shared/api/stocks.api";

describe("stocksApi 路由", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    apiMock.get.mockResolvedValue({ data: {} });
    apiMock.patch.mockResolvedValue({ data: {} });
    apiMock.delete.mockResolvedValue({ data: undefined });
  });

  it("库存凭证保留，不暴露物理删除客户端方法", () => {
    expect("remove" in stocksApi).toBe(false);
  });

  it("不再暴露旧库存列表与资料更新客户端方法", () => {
    expect("list" in stocksApi).toBe(false);
    expect("updateProfile" in stocksApi).toBe(false);
  });

  it("库存台账导出走后端筛选接口并读取明细失败计数", async () => {
    const blob = new Blob(["csv"]);
    apiMock.get.mockResolvedValueOnce({
      data: blob,
      headers: { "x-inventory-detail-failures": "2" },
    });

    const result = await stocksApi.inventoryLedgerExport({
      business_mode: "SELF",
      sort_desc: false,
    });

    expect(apiMock.get).toHaveBeenCalledWith(
      "/stocks/inventory/ledger/export.csv",
      expect.objectContaining({
        params: expect.objectContaining({ business_mode: "SELF", sort_desc: false }),
        responseType: "blob",
        bypassCache: true,
        timeout: 120_000,
      }),
    );
    expect(result).toEqual({ blob, failedDetailCount: 2 });
  });
});
