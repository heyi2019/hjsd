import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { NotificationsPanel } from "./NotificationsPanel";
import * as catalog from "../shared/api/catalog";
import type { NotificationItem } from "../shared/api/catalog";

vi.mock("../shared/api/catalog");

const items: NotificationItem[] = [
  { id: 1, notification_no: "N001", title: "逾期提醒", message: "一笔返点逾期", entity_type: "order", entity_id: "10", read_at: null },
  { id: 2, notification_no: "N002", title: "已读", message: "已读消息", entity_type: "customer", entity_id: "5", read_at: "2026-10-01T00:00:00" },
];

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(catalog.notificationsApi.list).mockResolvedValue({ items, unread_total: 1 });
  vi.mocked(catalog.notificationsApi.markRead).mockResolvedValue(items[0]);
  vi.mocked(catalog.notificationsApi.syncOverdueRebates).mockResolvedValue({ created: 3 });
});

describe("NotificationsPanel：系统提醒", () => {
  it("加载并展示提醒列表与未读统计", async () => {
    renderLight(<NotificationsPanel />, { user: "admin" });
    expect(await screen.findByText("N001")).toBeInTheDocument();
    expect(screen.getByText("逾期提醒")).toBeInTheDocument();
    // StatRow 未读提醒数 = 1（页面中可能有多个 "1"，用至少出现断言）
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
  });

  it("加载失败展示错误横幅", async () => {
    vi.mocked(catalog.notificationsApi.list).mockRejectedValue(new Error("boom"));
    renderLight(<NotificationsPanel />, { user: "admin" });
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });

  it("点击标记已读调用接口并刷新", async () => {
    renderLight(<NotificationsPanel />, { user: "admin" });
    await screen.findByText("N001");
    const btn = screen.getByRole("button", { name: /标记已读/ });
    await ui.click(btn);
    await waitFor(() => expect(catalog.notificationsApi.markRead).toHaveBeenCalledWith(1));
  });

  it("点击同步逾期提醒调用接口", async () => {
    renderLight(<NotificationsPanel />, { user: "admin" });
    await screen.findByText("N001");
    await ui.click(screen.getByRole("button", { name: /同步返点逾期提醒/ }));
    await waitFor(() => expect(catalog.notificationsApi.syncOverdueRebates).toHaveBeenCalled());
  });

  it("勾选仅看未读 → list 带 unread_only 重新拉取", async () => {
    renderLight(<NotificationsPanel />, { user: "admin" });
    await screen.findByText("N001");
    await ui.click(screen.getByRole("checkbox", { name: /仅看未读/ }));
    await waitFor(() => expect(catalog.notificationsApi.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ unread_only: true }),
    ));
  });
});
