import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@/shared/api/client", () => ({ api: apiMock }));

import { stocksApi } from "@/shared/api/catalog";

describe("stocksApi 路由", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    apiMock.get.mockResolvedValue({ data: {} });
    apiMock.patch.mockResolvedValue({ data: {} });
  });

  it("所有库存详情读写请求都使用 /stocks 路由", async () => {
    await stocksApi.updateProfile(7, { note: "备注" });
    await stocksApi.executionDetail(7);
    await stocksApi.updateExecution(7, { profile: {}, events: [] });

    expect(apiMock.patch).toHaveBeenNthCalledWith(1, "/stocks/7", { note: "备注" });
    expect(apiMock.get).toHaveBeenCalledWith("/stocks/7/execution-detail");
    expect(apiMock.patch).toHaveBeenNthCalledWith(2, "/stocks/7/execution-edit", { profile: {}, events: [] });
  });
});
