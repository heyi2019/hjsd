import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { AuditPanel } from "./AuditPanel";
import * as catalog from "../shared/api/catalog";
import type { AuditLogRow } from "../shared/api/catalog";

vi.mock("../shared/api/catalog");

const rows: AuditLogRow[] = [
  { id: 1, occurred_at: "2026-10-01", actor: "admin", action: "ORDER_CREATE", entity_type: "order", entity_id: "10", reason: null },
];

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(catalog.auditApi.list).mockResolvedValue({ items: rows, total: rows.length });
  vi.mocked(catalog.auditApi.actions).mockResolvedValue(["ORDER_CREATE"]);
});

describe("AuditPanel：审计记录", () => {
  it("加载并展示审计行", async () => {
    renderLight(<AuditPanel />, { user: "admin" });
    expect(await screen.findByText("admin")).toBeInTheDocument();
    // 动作与对象类型均按中文标签渲染（AUDIT_ACTION_LABEL / ENTITY_TYPE_LABEL）
    expect(screen.getByText("新建订单")).toBeInTheDocument();
    expect(screen.getByText("订单")).toBeInTheDocument();
  });

  it("加载失败展示错误横幅", async () => {
    vi.mocked(catalog.auditApi.list).mockRejectedValue(new Error("audit down"));
    renderLight(<AuditPanel />, { user: "admin" });
    expect(await screen.findByText(/audit down/)).toBeInTheDocument();
  });

  it("按对象编号筛选重新加载", async () => {
    renderLight(<AuditPanel />, { user: "admin" });
    await screen.findByText("admin");
    const before = vi.mocked(catalog.auditApi.list).mock.calls.length;
    await ui.type(screen.getByPlaceholderText("对象编号"), "10");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(vi.mocked(catalog.auditApi.list).mock.calls.length).toBeGreaterThan(before));
  });
});
