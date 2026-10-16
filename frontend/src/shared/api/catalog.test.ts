import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({
  api: { get: vi.fn() },
}));

import { api } from "./client";
import { auditApi } from "./catalog";

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
