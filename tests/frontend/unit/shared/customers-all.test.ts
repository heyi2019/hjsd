import { describe, expect, it, vi } from "vitest";
import { api } from "@/shared/api/client";
import { customersApi } from "@/shared/api/customers.api";

describe("客户列表", () => {
  it("客户分页保留筛选、页码和服务端总数", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValueOnce({ data: { items: [{ id: 501 }], total: 501, limit: 10, offset: 500 } } as never);
    try {
      const result = await customersApi.page({ status: "ACTIVE", limit: 10, offset: 500 });
      expect(result.total).toBe(501);
      expect(result.items[0].id).toBe(501);
      expect(get).toHaveBeenCalledWith("/customers", expect.objectContaining({ params: { status: "ACTIVE", limit: 10, offset: 500 } }));
    } finally { get.mockRestore(); }
  });
});
