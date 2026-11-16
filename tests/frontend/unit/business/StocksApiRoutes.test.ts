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

  it("删除库存走 DELETE /stocks/{id} 且请求体带删除原因", async () => {
    await stocksApi.remove(7, "重复录入");

    expect(apiMock.delete).toHaveBeenCalledWith("/stocks/7", { data: { reason: "重复录入" } });
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
      }),
    );
    expect(result).toEqual({ blob, failedDetailCount: 2 });
  });
});
