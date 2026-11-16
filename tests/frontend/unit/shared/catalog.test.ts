import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/client", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

import { api } from "@/shared/api/client";
import { installmentsApi } from "@/shared/api/installments.api";
import { teamsApi, usersApi } from "@/shared/api/org.api";
import { auditApi } from "@/shared/api/reports.api";

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
  it("分期列表直接返回期次和处置明细", async () => {
    const rows = [{ id: 7, schedules: [], dispositions: [] }];
    vi.mocked(api.get).mockResolvedValueOnce({ data: rows });
    await expect(installmentsApi.list()).resolves.toEqual(rows);
    expect(api.get).toHaveBeenCalledWith("/installments", { params: undefined });
  });
});

describe("组织 API：统一通过领域客户端访问", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
    vi.mocked(api.patch).mockReset();
  });

  it("用户列表、创建、更新和重置密码使用固定路径", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: [] });
    vi.mocked(api.post)
      .mockResolvedValueOnce({ data: { id: 1 } })
      .mockResolvedValueOnce({ data: { ok: true } });
    vi.mocked(api.patch).mockResolvedValueOnce({ data: { id: 1 } });
    await usersApi.list();
    await usersApi.create({ username: "u", password: "password123" });
    await usersApi.update(1, { is_active: false });
    await usersApi.resetPassword(1, "password123");
    expect(api.get).toHaveBeenCalledWith("/users");
    expect(api.post).toHaveBeenCalledWith("/users", { username: "u", password: "password123" });
    expect(api.patch).toHaveBeenCalledWith("/users/1", { is_active: false });
    expect(api.post).toHaveBeenCalledWith("/users/1/reset-password", { password: "password123" });
  });

  it("团队列表、创建和更新使用固定路径", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: [] });
    vi.mocked(api.post).mockResolvedValueOnce({ data: { id: 1 } });
    vi.mocked(api.patch).mockResolvedValueOnce({ data: { id: 1 } });
    await teamsApi.list();
    await teamsApi.create({ code: "T1", name: "一队" });
    await teamsApi.update(1, { is_active: false });
    expect(api.get).toHaveBeenCalledWith("/teams");
    expect(api.post).toHaveBeenCalledWith("/teams", { code: "T1", name: "一队" });
    expect(api.patch).toHaveBeenCalledWith("/teams/1", { is_active: false });
  });
});
