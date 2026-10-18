import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";

const gameTypesApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setActive: vi.fn(),
  setDefault: vi.fn(),
}));

vi.mock("../../shared/api/catalog", () => ({ gameTypesApi }));

describe("GameTypeSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gameTypesApi.list.mockResolvedValue([]);
  });

  it("does not let browser form-history values appear as game type suggestions", async () => {
    const { GameTypeSettingsPanel } = await import("./GameTypeSettingsPanel");
    renderLight(<GameTypeSettingsPanel />, { user: "admin" });

    const input = await screen.findByPlaceholderText("如：王者荣耀");
    expect(input).toHaveAttribute("name", "game_type_name");
    expect(input).toHaveAttribute("autocomplete", "off");
  });
});
