import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../shared/api/catalog";
import { renderLight } from "../test/render";
import { InventoryProfileModal } from "./InventoryProfileModal";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

const updateProfile = vi.fn();

vi.mock("../shared/api/catalog", () => ({
  accountsApi: {
    updateProfile: (...args: unknown[]) => updateProfile(...args),
  },
}));

const account = {
  id: 1,
  game_account: "acc-1",
  game_type: "手游",
  account_description: "旧描述",
  account_images: [],
  status: "IN_STOCK",
  inventory_type: "RECOVERY",
} as unknown as Account;

beforeEach(() => {
  vi.clearAllMocks();
  updateProfile.mockResolvedValue({ ...account, account_description: "新描述" });
});

describe("InventoryProfileModal", () => {
  it("按账号描述模式提交资料并回传更新结果", async () => {
    const onSaved = vi.fn();
    renderLight(
      <InventoryProfileModal
        target={{ account, mode: "description" }}
        onClose={vi.fn()}
        onSaved={onSaved}
        onError={vi.fn()}
      />,
      { user: "admin" },
    );

    const description = screen.getByPlaceholderText("补充账号等级、资源、限制等信息");
    await ui.clear(description);
    await ui.type(description, "新描述");
    await ui.click(screen.getByRole("button", { name: /保存/ }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith(1, { account_description: "新描述" }));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ account_description: "新描述" }));
  });
});
