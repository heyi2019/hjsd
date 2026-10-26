/** OptionSetsPanel 测试：死枚举改文案 + 可编辑字典可增删改并写回。
 *
 * 2026-10-26 裁决后死枚举的口径变了：值集合锁死（后端 CHECK 保护），
 * 但展示文案可在设置页维护。故断言从「只读不可改」改为「值只读 · 文案可改」。
 */
import { screen, waitFor, within } from "@testing-library/react";
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

/** 按卡片标题定位卡片，避免「保存文案」与「保存」按钮在整页范围内串位。 */
function cardOf(title: string): HTMLElement {
  const heading = screen.getByText(title);
  const card = heading.closest(".ant-card");
  if (!card) throw new Error(`未找到卡片：${title}`);
  return card as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.optionSetsApi.list).mockResolvedValue({
    items: [READONLY_SET, EDITABLE_SET],
  });
  vi.mocked(catalog.optionSetsApi.update).mockResolvedValue(READONLY_SET);
});

describe("OptionSetsPanel：死枚举值只读 · 文案可改", () => {
  it("展示新标记，每个值配一个展示文案输入框", async () => {
    renderLight(<OptionSetsPanel />, { user: "admin" });
    expect(await screen.findByText("库存状态")).toBeInTheDocument();
    expect(screen.getByText("值只读 · 文案可改")).toBeInTheDocument();

    const card = cardOf("库存状态");
    // 值以 Tag 形式锁死展示
    expect(within(card).getByText("IN_STOCK")).toBeInTheDocument();
    expect(within(card).getByText("SOLD")).toBeInTheDocument();
    // 文案可改：按 aria-label 定位输入框，初值为词典 label
    expect(within(card).getByLabelText("库存状态 IN_STOCK 展示文案")).toHaveValue("在库");
    expect(within(card).getByLabelText("库存状态 SOLD 展示文案")).toHaveValue("已售");
  });

  it("改文案保存：回传原 value 序列 + 新 label，值集合不变", async () => {
    renderLight(<OptionSetsPanel />, { user: "admin" });
    await screen.findByText("库存状态");
    const card = cardOf("库存状态");

    const input = within(card).getByLabelText("库存状态 IN_STOCK 展示文案");
    await userEvent.clear(input);
    await userEvent.type(input, "在库中");
    await userEvent.click(within(card).getByRole("button", { name: /保存文案/ }));

    await waitFor(() =>
      expect(vi.mocked(catalog.optionSetsApi.update)).toHaveBeenCalledWith("INVENTORY_STATUS", {
        options: [
          { value: "IN_STOCK", label: "在库中" },
          { value: "SOLD", label: "已售" },
        ],
      }),
    );
  });

  it("文案清空时拒绝保存，不调用 update", async () => {
    renderLight(<OptionSetsPanel />, { user: "admin" });
    await screen.findByText("库存状态");
    const card = cardOf("库存状态");

    const input = within(card).getByLabelText("库存状态 SOLD 展示文案");
    await userEvent.clear(input);
    // 前端先拦（空文案不提交），后端另有二次校验，双保险
    await userEvent.click(within(card).getByRole("button", { name: /保存文案/ }));
    expect(vi.mocked(catalog.optionSetsApi.update)).not.toHaveBeenCalled();
  });
});

describe("OptionSetsPanel：可编辑字典", () => {
  it("展示可编辑标记，并能新增选项后写回", async () => {
    renderLight(<OptionSetsPanel />, { user: "admin" });
    expect(await screen.findByText("游戏标签")).toBeInTheDocument();
    expect(screen.getByText("可编辑")).toBeInTheDocument();

    const card = cardOf("游戏标签");
    await userEvent.click(within(card).getByRole("button", { name: /添加选项/ }));
    const valueInputs = within(card).getAllByPlaceholderText("value（后端枚举码/字典键）");
    await userEvent.type(valueInputs[valueInputs.length - 1], "NEW");
    const labelInputs = within(card).getAllByPlaceholderText("label（展示名）");
    await userEvent.type(labelInputs[labelInputs.length - 1], "新品");

    await userEvent.click(within(card).getByRole("button", { name: /保存/ }));

    await waitFor(() =>
      expect(
        vi.mocked(catalog.optionSetsApi.update).mock.calls.some(
          (c) =>
            c[0] === "GAME_TAG" &&
            (c[1] as { options?: Array<{ value: string }> })?.options?.some((o) => o.value === "NEW"),
        ),
      ).toBe(true),
    );
  });
});
