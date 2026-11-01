import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";
import * as catalog from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");

describe("BusinessReminderSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("业务提醒读取失败时锁定保存按钮并提供重试入口（L1659）", async () => {
    vi.mocked(catalog.optionSetsApi).get.mockRejectedValue(new Error("提醒配置读取失败"));
    const { BusinessReminderSettingsPanel } = await import("./BusinessReminderSettingsPanel");
    renderLight(<BusinessReminderSettingsPanel />, { user: "admin" });

    // 错误态可见，不应误导用户为「已加载可编辑」
    expect(await screen.findByText(/提醒配置读取失败/)).toBeInTheDocument();
    // 读取失败时保存按钮被禁用，避免用默认值覆盖真实配置
    expect(screen.getByRole("button", { name: /保存配置/ })).toBeDisabled();
    // 保留重试入口，重试成功后恢复可编辑
    expect(screen.getByRole("button", { name: /重新加载/ })).toBeInTheDocument();
  });

  it("业务提醒正常加载后保存按钮可用（L1659 反向保障）", async () => {
    vi.mocked(catalog.optionSetsApi).get.mockResolvedValue({
      options: [{ value: "inventory_aging_days", label: "库存订单超过多少天提醒", value2: "7" }],
    } as never);
    vi.mocked(catalog.optionSetsApi).update.mockResolvedValue(undefined as never);
    const { BusinessReminderSettingsPanel } = await import("./BusinessReminderSettingsPanel");
    renderLight(<BusinessReminderSettingsPanel />, { user: "admin" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /保存配置/ })).toBeEnabled(),
    );
  });
});
