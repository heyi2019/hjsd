import { screen } from "@testing-library/react";
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
});
