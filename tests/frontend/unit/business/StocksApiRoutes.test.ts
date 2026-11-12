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

  it("所有库存详情读写请求都使用 /stocks 路由", async () => {
    await stocksApi.updateProfile(7, { note: "备注" });
    await stocksApi.executionDetail(7);
    await stocksApi.updateExecution(7, { profile: {}, events: [] });

    expect(apiMock.patch).toHaveBeenNthCalledWith(1, "/stocks/7", { note: "备注" });
    expect(apiMock.get).toHaveBeenCalledWith("/stocks/7/execution-detail");
    expect(apiMock.patch).toHaveBeenNthCalledWith(2, "/stocks/7/execution-edit", { profile: {}, events: [] });
  });

  it("删除账号走 DELETE /stocks/{id} 且请求体带删除原因", async () => {
    await stocksApi.remove(7, "重复录入");

    expect(apiMock.delete).toHaveBeenCalledWith("/stocks/7", { data: { reason: "重复录入" } });
  });
});
