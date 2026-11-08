/** ListColumnsPanel：列表列显示/顺序配置面板。
 *  覆盖：拉取三张列表、切换列表、隐藏列、上下移动顺序、锁定列不可隐藏。 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "@/shared/api/catalog";

vi.mock("@/shared/api/catalog");

import { renderLight } from "@fixtures/render";
import { ListColumnsPanel } from "@/field-definitions/panels/ListColumnsPanel";

const ledger: catalog.ListScopeConfig = {
  code: "LEDGER",
  label: "订单台账",
  columns: [
    { key: "order_no", label: "订单号", locked: true, is_visible: true, sort_order: 0 },
    { key: "party", label: "对方 / 来源", locked: false, is_visible: true, sort_order: 10 },
    { key: "actions", label: "操作", locked: true, is_visible: true, sort_order: 20 },
  ],
};

const inventory: catalog.ListScopeConfig = {
  code: "INVENTORY",
  label: "库存中心",
  columns: [
    { key: "stock_no", label: "库存编号", locked: true, is_visible: true, sort_order: 0 },
    { key: "cost_amount", label: "成本", locked: false, is_visible: true, sort_order: 10 },
  ],
};

const customColumn: catalog.ListColumnConfig = {
  key: "extra:vip_tag",
  label: "VIP 标签",
  locked: false,
  is_visible: true,
  sort_order: 90,
  custom: true,
  source_key: "vip_tag",
  value_labels: { A: "甲" },
};

const ledgerWithCustom: catalog.ListScopeConfig = {
  ...ledger,
  columns: [...ledger.columns, customColumn],
};

describe("ListColumnsPanel", () => {
  beforeEach(() => {
    vi.mocked(catalog.listColumnsApi.all).mockResolvedValue([ledger, inventory]);
    vi.mocked(catalog.listColumnsApi.reset).mockResolvedValue(ledger);
    vi.mocked(catalog.listColumnsApi.customFields).mockResolvedValue([
      {
        scope: "CUSTOMER",
        scope_label: "客户建档",
        field_key: "vip_tag",
        label: "VIP 标签",
        field_type: "SELECT",
        options: [{ value: "A", label: "甲" }],
      },
      {
        scope: "DATA",
        scope_label: "数据中已有值",
        field_key: "qa500_note",
        label: "qa500_note",
        field_type: "TEXT",
        options: [],
        data_only: true,
        source_label: "订单",
        row_count: 311,
      },
    ]);
    vi.mocked(catalog.listColumnsApi.addCustom).mockImplementation(async (scope, fieldKey, label) => ({
      ...(scope === "LEDGER" ? ledger : inventory),
      columns: [
        ...(scope === "LEDGER" ? ledger : inventory).columns,
        { ...customColumn, key: `extra:${fieldKey}`, label: label || "VIP 标签" },
      ],
    }));
    vi.mocked(catalog.listColumnsApi.removeCustom).mockResolvedValue(ledger);
    vi.mocked(catalog.listColumnsApi.save).mockImplementation(async (scope, items) => ({
      ...(scope === "LEDGER" ? ledger : inventory),
      columns: items.map((item, index) => ({
        key: item.key,
        label: (scope === "LEDGER" ? ledger : inventory).columns.find((c) => c.key === item.key)?.label ?? item.key,
        locked: (scope === "LEDGER" ? ledger : inventory).columns.find((c) => c.key === item.key)?.locked ?? false,
        is_visible: item.is_visible,
        sort_order: index * 10,
        width: item.width ?? null,
        fixed: item.fixed ?? null,
      })),
    }));
  });

  it("隐藏列：提交整表且该列 is_visible=false", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "显示_party" }));

    await waitFor(() => expect(catalog.listColumnsApi.save).toHaveBeenCalled());
    const [scope, items] = vi.mocked(catalog.listColumnsApi.save).mock.calls[0];
    expect(scope).toBe("LEDGER");
    expect(items.find((item) => item.key === "party")?.is_visible).toBe(false);
    expect(items.map((item) => item.key)).toEqual(["order_no", "party", "actions"]);
  });

  it("下移列：提交顺序随数组位置变化", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "下移_party" }));

    await waitFor(() => expect(catalog.listColumnsApi.save).toHaveBeenCalled());
    const [, items] = vi.mocked(catalog.listColumnsApi.save).mock.calls[0];
    expect(items.map((item) => item.key)).toEqual(["order_no", "actions", "party"]);
    expect(items.map((item) => item.sort_order)).toEqual([0, 10, 20]);
  });

  it("切换列表后展示目标列表的列", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("订单台账")).toBeInTheDocument());

    const master = screen.getByTestId("list-columns-master");
    await userEvent.click(within(master).getByRole("combobox"));
    await userEvent.click(await screen.findByTitle("库存中心"));

    await waitFor(() => expect(screen.getByText("库存编号")).toBeInTheDocument());
    expect(screen.queryByText("对方 / 来源")).not.toBeInTheDocument();
  });

  it("列宽：输入后不立即提交，失焦才提交一次并夹到 40~800", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    const input = screen.getByRole("spinbutton", { name: "列宽_party" });
    await userEvent.clear(input);
    await userEvent.type(input, "180");
    // 打字过程中不打接口
    expect(catalog.listColumnsApi.save).not.toHaveBeenCalled();

    await userEvent.tab();
    await waitFor(() => expect(catalog.listColumnsApi.save).toHaveBeenCalledTimes(1));
    const [, items] = vi.mocked(catalog.listColumnsApi.save).mock.calls[0];
    expect(items.find((item) => item.key === "party")?.width).toBe(180);

    // 越界值由组件夹到 40~800，避免提交必然 422 的请求
    const again = screen.getByRole("spinbutton", { name: "列宽_party" });
    await userEvent.clear(again);
    await userEvent.type(again, "9999");
    await userEvent.tab();
    await waitFor(() => expect(catalog.listColumnsApi.save).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(catalog.listColumnsApi.save).mock.calls;
    const clamped = calls[calls.length - 1][1].find((item) => item.key === "party")?.width ?? 0;
    expect(clamped).toBeLessThanOrEqual(800);
    expect(clamped).toBeGreaterThanOrEqual(40);
  });

  it("固定列：选中后随整表提交，且不覆盖已设列宽", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    const input = screen.getByRole("spinbutton", { name: "列宽_party" });
    await userEvent.clear(input);
    await userEvent.type(input, "200");
    await userEvent.tab();
    await waitFor(() => expect(catalog.listColumnsApi.save).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("combobox", { name: "固定_party" }));
    await userEvent.click(await screen.findByTitle("固定左侧"));
    await waitFor(() => expect(catalog.listColumnsApi.save).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(catalog.listColumnsApi.save).mock.calls;
    const lastItems = calls[calls.length - 1][1];
    expect(lastItems.find((item) => item.key === "party")?.fixed).toBe("left");
    expect(lastItems.find((item) => item.key === "party")?.width).toBe(200);
  });

  it("全部显示：一次提交把所有列设为可见", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "显示_party" }));
    await waitFor(() => expect(catalog.listColumnsApi.save).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "显示全部列" }));
    await waitFor(() => expect(catalog.listColumnsApi.save).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(catalog.listColumnsApi.save).mock.calls;
    expect(calls[calls.length - 1][1].every((item) => item.is_visible)).toBe(true);
  });

  it("恢复默认：二次确认后清空该列表配置并回填默认列", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "恢复默认列配置" }));
    await userEvent.click(await screen.findByText("确认恢复"));

    await waitFor(() => expect(catalog.listColumnsApi.reset).toHaveBeenCalledWith("LEDGER"));
    await waitFor(() => expect(screen.getByText("订单号")).toBeInTheDocument());
    expect(screen.getByText("对方 / 来源")).toBeInTheDocument();
  });

  it("新增列：选字段后确认，回填自定义列并标注「自定义」", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("订单号")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "新增列" }));
    await userEvent.click(await screen.findByRole("combobox", { name: "自定义列来源字段" }));
    await userEvent.click(await screen.findByTitle("VIP 标签（vip_tag）"));
    await userEvent.click(screen.getByRole("button", { name: /确认新增/ }));

    await waitFor(() =>
      expect(catalog.listColumnsApi.addCustom).toHaveBeenCalledWith("LEDGER", "vip_tag", ""),
    );
    await waitFor(() => expect(screen.getByText("VIP 标签")).toBeInTheDocument());
    expect(screen.getAllByText("自定义").length).toBeGreaterThan(0);
  });

  it("新增列可自定义列名", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("订单号")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "新增列" }));
    await userEvent.click(await screen.findByRole("combobox", { name: "自定义列来源字段" }));
    await userEvent.click(await screen.findByTitle("VIP 标签（vip_tag）"));
    await userEvent.type(screen.getByRole("textbox", { name: "自定义列列名" }), "会员等级");
    await userEvent.click(screen.getByRole("button", { name: /确认新增/ }));

    await waitFor(() =>
      expect(catalog.listColumnsApi.addCustom).toHaveBeenCalledWith("LEDGER", "vip_tag", "会员等级"),
    );
  });

  it("新增列：「数据中已有值」分组按来源与行数展示并可选", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("订单号")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "新增列" }));
    await userEvent.click(await screen.findByRole("combobox", { name: "自定义列来源字段" }));

    const option = await screen.findByTitle("qa500_note（qa500_note，订单 311 行）");
    expect(option).toBeInTheDocument();
    expect(screen.getByText("数据中已有值（按原值展示）")).toBeInTheDocument();

    await userEvent.click(option);
    await userEvent.click(screen.getByRole("button", { name: /确认新增/ }));
    await waitFor(() =>
      expect(catalog.listColumnsApi.addCustom).toHaveBeenCalledWith("LEDGER", "qa500_note", ""),
    );
  });

  it("删除自定义列：二次确认后调用 removeCustom 并从列表移除", async () => {
    vi.mocked(catalog.listColumnsApi.all).mockResolvedValue([ledgerWithCustom, inventory]);
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("VIP 标签")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "删除_extra:vip_tag" }));
    await userEvent.click(await screen.findByText("确认删除"));

    await waitFor(() =>
      expect(catalog.listColumnsApi.removeCustom).toHaveBeenCalledWith(
        "LEDGER",
        "extra:vip_tag",
      ),
    );
    await waitFor(() => expect(screen.queryByText("VIP 标签")).not.toBeInTheDocument());
  });

  it("批量隐藏：勾选后「隐藏所选」一次整表提交，所有列均可勾选", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    // 身份列（订单号）的选择框现在可勾选
    const orderRow = screen.getByText("订单号").closest("tr") as HTMLElement;
    expect(orderRow.querySelector('input[type="checkbox"]')).not.toBeDisabled();

    // 勾选「对方 / 来源」后批量隐藏
    const partyRow = screen.getByText("对方 / 来源").closest("tr") as HTMLElement;
    await userEvent.click(partyRow.querySelector('input[type="checkbox"]') as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "隐藏所选列" }));

    await waitFor(() => expect(catalog.listColumnsApi.save).toHaveBeenCalledTimes(1));
    const [scope, items] = vi.mocked(catalog.listColumnsApi.save).mock.calls[0];
    expect(scope).toBe("LEDGER");
    const party = (items as Array<{ key: string; is_visible: boolean }>).find(
      (item) => item.key === "party",
    );
    expect(party?.is_visible).toBe(false);
  });

  it("拖拽排序：拖起一行 drop 到另一行位置后整表提交新顺序", async () => {
    const { fireEvent } = await import("@testing-library/react");
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    // 行 tr 由 antd 写入 data-row-key（列键），避开与表头同名文本的歧义
    const sourceRow = document.querySelector('tr[data-row-key="actions"]') as HTMLElement;
    const targetRow = document.querySelector('tr[data-row-key="order_no"]') as HTMLElement;
    expect(sourceRow).toBeTruthy();
    expect(targetRow).toBeTruthy();

    fireEvent.dragStart(sourceRow);
    fireEvent.drop(targetRow);

    await waitFor(() => expect(catalog.listColumnsApi.save).toHaveBeenCalledTimes(1));
    const [, items] = vi.mocked(catalog.listColumnsApi.save).mock.calls[0];
    const order = (items as Array<{ key: string }>).map((item) => item.key);
    expect(order[0]).toBe("actions");
    expect(order.indexOf("order_no")).toBe(1);
  });
});
