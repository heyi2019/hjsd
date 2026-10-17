import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({
  api: { get: vi.fn() },
}));

import { api } from "./client";
import { auditApi, installmentsApi, reportsApi } from "./catalog";

describe("auditApi：与后端审计查询契约一致", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
  });

  it("actions 解包后端的 items 包装", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: { items: ["EVENT_POST"] } });

    await expect(auditApi.actions()).resolves.toEqual(["EVENT_POST"]);
    expect(api.get).toHaveBeenCalledWith("/audit-logs/actions");
  });
});

describe("页面接口契约", () => {
  it("分期处置和资金分析读取后端接口", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { items: [], total_amount: "0", total_signed_amount: "0" } });
    await reportsApi.financeDimensions({ from: "2026-10-01" });
    expect(api.get).toHaveBeenCalledWith("/reports/finance-dimensions", { params: { from: "2026-10-01" } });
    vi.mocked(api.get).mockResolvedValueOnce({ data: [] });
    expect(await installmentsApi.dispositions(7)).toEqual([]);
    expect(api.get).toHaveBeenCalledWith("/installments/7/dispositions");
  });
});
