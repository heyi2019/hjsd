import { describe, expect, it, vi } from "vitest";
import { api } from "@/shared/api/client";
import { customersApi } from "@/shared/api/customers.api";

describe("客户列表", () => {
  it("分批读取所有客户，包括第一页之后的数据", async () => {
    const first = Array.from({ length: 500 }, (_, index) => ({ id: index + 1 }));
    const get = vi.spyOn(api, "get").mockResolvedValueOnce({ data: { items: first, total: 501 } } as never).mockResolvedValueOnce({ data: { items: [{ id: 501 }], total: 501 } } as never);
    try {
      const result = await customersApi.list({ status: "ACTIVE" });
      expect(result).toHaveLength(501);
      expect(result[500].id).toBe(501);
    } finally { get.mockRestore(); }
  });
});
