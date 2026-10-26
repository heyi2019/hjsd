/** OptionSetsPanel 测试：只读死枚举展示 + 可编辑字典可增删改并写回。 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");
import { renderLight } from "../../test/render";
import { OptionSetsPanel } from "./OptionSetsPanel";

const READONLY_SET = {
  id: 1,
  code: "INVENTORY_STATUS",
  label: "库存状态",
  group: "INVENTORY",
  editable: false,
  options: [
    { value: "IN_STOCK", label: "在库" },
    { value: "SOLD", label: "已售" },
  ],
  description: "后端死枚举",
};

const EDITABLE_SET = {
  id: 2,
  code: "GAME_TAG",
  label: "游戏标签",
  group: "INVENTORY",
  editable: true,
  options: [{ value: "HOT", label: "热门" }],
  description: "可自由增删",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.optionSetsApi.list).mockResolvedValue({
    items: [READONLY_SET, EDITABLE_SET],
  });
});

describe("OptionSetsPanel：只读死枚举", () => {
  it("展示只读标记与全部选项", async () => {
    renderLight(<OptionSetsPanel />, { user: "admin" });
    expect(await screen.findByText("库存状态")).toBeInTheDocument();
    expect(screen.getByText("只读（后端死枚举）")).toBeInTheDocument();
    expect(screen.getByText("在库（IN_STOCK）")).toBeInTheDocument();
    expect(screen.getByText("已售（SOLD）")).toBeInTheDocument();
  });
});

describe("OptionSetsPanel：可编辑字典", () => {
  it("展示可编辑标记，并能新增选项后写回", async () => {
    renderLight(<OptionSetsPanel />, { user: "admin" });
    expect(await screen.findByText("游戏标签")).toBeInTheDocument();
    expect(screen.getByText("可编辑")).toBeInTheDocument();

    // 新增一行
    const addButtons = screen.getAllByRole("button", { name: /添加选项/ });
    await userEvent.click(addButtons[0]);
    const valueInputs = screen.getAllByPlaceholderText("value（后端枚举码/字典键）");
    await userEvent.type(valueInputs[valueInputs.length - 1], "NEW");
    const labelInputs = screen.getAllByPlaceholderText("label（展示名）");
    await userEvent.type(labelInputs[labelInputs.length - 1], "新品");

    const saveButtons = screen.getAllByRole("button", { name: /保存/ });
    await userEvent.click(saveButtons[0]);

    await waitFor(() =>
      expect(vi.mocked(catalog.optionSetsApi.update).mock.calls.some((c) =>
        c[0] === "GAME_TAG" &&
        (c[1] as { options?: Array<{ value: string }> })?.options?.some((o) => o.value === "NEW"),
      )).toBe(true),
    );
  });
});
