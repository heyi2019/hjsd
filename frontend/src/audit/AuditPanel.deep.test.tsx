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

async function pickSelectByIndex(index: number, optionLabel: string) {
  const select = document.querySelectorAll(".ant-select")[index] as HTMLElement;
  await ui.click(select.querySelector(".ant-select-selector") as HTMLElement);
  await ui.click(await screen.findByText(optionLabel, { selector: ".ant-select-item-option-content" }));
}

function lastListArgs(): Record<string, unknown> {
  const calls = vi.mocked(catalog.auditApi.list).mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

describe("AuditPanel.deep：筛选/重试/降级分支", () => {
  it("加载失败：错误横幅可点「重新加载」再次请求 list", async () => {
    vi.mocked(catalog.auditApi.list).mockRejectedValue(new Error("audit down"));
    renderLight(<AuditPanel />, { user: "admin" });
    expect((await screen.findAllByText(/audit down/)).length).toBeGreaterThan(0);
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await waitFor(() => expect(vi.mocked(catalog.auditApi.list)).toHaveBeenCalledTimes(2));
  });

  it("动作选项加载失败：降级为空、页面不崩、列表仍加载", async () => {
    vi.mocked(catalog.auditApi.actions).mockRejectedValue(new Error("no actions"));
    renderLight(<AuditPanel />, { user: "admin" });
    // 列表本身加载成功（rows 可见）
    expect(await screen.findByText("admin")).toBeInTheDocument();
    // 动作下拉已降级为空数组，但 Select 仍可渲染（audit 面板标题存在即不崩）
    expect(screen.getByText("审计记录")).toBeInTheDocument();
    expect(vi.mocked(catalog.auditApi.list)).toHaveBeenCalledTimes(1);
  });

  it("空数据：展示 emptyText「暂无审计记录」", async () => {
    vi.mocked(catalog.auditApi.list).mockResolvedValue({ items: [], total: 0 });
    renderLight(<AuditPanel />, { user: "admin" });
    expect(await screen.findByText("暂无审计记录")).toBeInTheDocument();
  });

  it("选对象类型触发 load 且参数带 entity_type", async () => {
    renderLight(<AuditPanel />, { user: "admin" });
    await screen.findByText("admin");
    await pickSelectByIndex(0, "订单");
    await waitFor(() => expect(lastListArgs().entity_type).toBe("order"));
  });

  it("选动作触发 load 且参数带 action", async () => {
    renderLight(<AuditPanel />, { user: "admin" });
    await screen.findByText("admin");
    await pickSelectByIndex(1, "新建订单");
    await waitFor(() => expect(lastListArgs().action).toBe("ORDER_CREATE"));
  });

  it("填操作人并按 Enter 触发 load 且参数带 actor", async () => {
    renderLight(<AuditPanel />, { user: "admin" });
    await screen.findByText("admin");
    await ui.type(screen.getByPlaceholderText("操作人"), "operator01");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(lastListArgs().actor).toBe("operator01"));
  });

  it("填开始/结束日期触发 load 且参数带 from/to", async () => {
    renderLight(<AuditPanel />, { user: "admin" });
    await screen.findByText("admin");
    await ui.type(screen.getByLabelText("审计开始日期"), "2026-01-01");
    await ui.type(screen.getByLabelText("审计结束日期"), "2026-12-31");
    await waitFor(() => {
      const args = lastListArgs();
      expect(args.from).toBe("2026-01-01");
      expect(args.to).toBe("2026-12-31");
    });
  });
});
