import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";

import * as catalog from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");

describe("GameTypeSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(catalog.gameTypesApi).list.mockResolvedValue([]);
  });

  it("does not let browser form-history values appear as game type suggestions", async () => {
    const { GameTypeSettingsPanel } = await import("./GameTypeSettingsPanel");
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    const input = await screen.findByPlaceholderText("如：王者荣耀");
    expect(input).toHaveAttribute("name", "game_type_name");
    expect(input).toHaveAttribute("autocomplete", "off");
  });

  it("新建时勾选默认类型 → payload 带 is_default（后端 create 支持，edit 不传）", async () => {
    vi.mocked(catalog.gameTypesApi).create.mockResolvedValue({ id: 3, name: "蛋仔派对", sort_order: 0, is_active: true, is_default: true });
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    const { GameTypeSettingsPanel } = await import("./GameTypeSettingsPanel");
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    await ui.type(await screen.findByPlaceholderText("如：王者荣耀"), "蛋仔派对");
    await ui.click(screen.getByRole("checkbox", { name: /新建表单自动带出/ }));
    await ui.click(screen.getByRole("button", { name: /新增游戏类型/ }));
    await waitFor(() => expect(vi.mocked(catalog.gameTypesApi).create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "蛋仔派对", is_default: true }),
    ));
  });
});
