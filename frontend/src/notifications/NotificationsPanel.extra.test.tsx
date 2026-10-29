import { screen, waitFor, act } from "@testing-library/react";
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
});

describe("NotificationsPanel.extra：失败路径 / 重试 / 轮询", () => {
  it("标记已读失败展示错误横幅", async () => {
    vi.mocked(catalog.notificationsApi.markRead).mockRejectedValue(new Error("read-fail"));
    renderLight(<NotificationsPanel />, { user: "admin" });
    await screen.findByText("N001");
    await ui.click(screen.getByRole("button", { name: /标记已读/ }));
    expect(await screen.findByText(/read-fail/)).toBeInTheDocument();
  });

  it("加载失败点「重新加载」触发二次请求（onRetry）", async () => {
    vi.mocked(catalog.notificationsApi.list)
      .mockRejectedValueOnce(new Error("first-fail"))
      .mockResolvedValueOnce({ items, unread_total: 1 });
    renderLight(<NotificationsPanel />, { user: "admin" });
    expect(await screen.findByText(/first-fail/)).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await waitFor(() => expect(catalog.notificationsApi.list).toHaveBeenCalledTimes(2));
  });

  it("每 60s 可见状态下轮询刷新（setInterval 回调）", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    vi.useFakeTimers();
    try {
      renderLight(<NotificationsPanel />, { user: "admin" });
      // 初始 load 为微任务，flush 后 list 已被调用 1 次（effect 内同步调用）
      await act(async () => {
        await Promise.resolve();
      });
      expect(catalog.notificationsApi.list).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(catalog.notificationsApi.list).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
