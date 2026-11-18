/** ListColumnsPanel：列表列显示/顺序配置面板。
 *  覆盖：拉取三张列表、切换列表、隐藏列、上下移动顺序、锁定列不可隐藏。 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listColumnsApi } from "@/shared/api/orders.api";
import type { ListColumnConfig, ListScopeConfig } from "@/shared/api/types/forms";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

import { renderLight } from "@fixtures/render";
import { ListColumnsPanel } from "@/field-definitions/panels/ListColumnsPanel";

const ledger: ListScopeConfig = {
  code: "LEDGER",
  label: "订单台账",
  columns: [
    { key: "order_no", label: "订单号", locked: true, is_visible: true, sort_order: 0 },
    { key: "party", label: "对方 / 来源", locked: false, is_visible: true, sort_order: 10 },
    { key: "actions", label: "操作", locked: true, is_visible: true, sort_order: 20 },
  ],
};

const inventory: ListScopeConfig = {
  code: "INVENTORY",
  label: "库存中心",
  columns: [
    { key: "stock_no", label: "库存编号", locked: true, is_visible: true, sort_order: 0 },
    { key: "cost_amount", label: "成本", locked: false, is_visible: true, sort_order: 10 },
  ],
};

const customColumn: ListColumnConfig = {
  key: "extra:vip_tag",
  label: "VIP 标签",
  locked: false,
  is_visible: true,
  sort_order: 90,
  custom: true,
  source_key: "vip_tag",
  value_labels: { A: "甲" },
};

const ledgerWithCustom: ListScopeConfig = {
  ...ledger,
  columns: [...ledger.columns, customColumn],
};

describe("ListColumnsPanel", () => {
  it("不再提供列宽配置，只保留显示、顺序与固定列", async () => {
    renderLight(<ListColumnsPanel />, { user: "admin" });
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());
    expect(screen.queryByRole("columnheader", { name: "列宽" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: /列宽/ })).toBeNull();
  });

  beforeEach(() => {
    vi.mocked(listColumnsApi.all).mockResolvedValue([ledger, inventory]);
    vi.mocked(listColumnsApi.reset).mockResolvedValue(ledger);
    vi.mocked(listColumnsApi.customFields).mockResolvedValue([
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
    vi.mocked(listColumnsApi.addCustom).mockImplementation(async (scope, fieldKey, label) => ({
      ...(scope === "LEDGER" ? ledger : inventory),
      columns: [
        ...(scope === "LEDGER" ? ledger : inventory).columns,
        { ...customColumn, key: `extra:${fieldKey}`, label: label || "VIP 标签" },
      ],
    }));
    vi.mocked(listColumnsApi.removeCustom).mockResolvedValue(ledger);
    vi.mocked(listColumnsApi.save).mockImplementation(async (scope, items) => ({
      ...(scope === "LEDGER" ? ledger : inventory),
      columns: items.map((item, index) => ({
        key: item.key,
        label: (scope === "LEDGER" ? ledger : inventory).columns.find((c) => c.key === item.key)?.label ?? item.key,
        locked: (scope === "LEDGER" ? ledger : inventory).columns.find((c) => c.key === item.key)?.locked ?? false,
        is_visible: item.is_visible,
        sort_order: index * 10,
        fixed: item.fixed ?? null,
      })),
    }));
  });

  it("工具栏与明细表都约束在设置面板宽度内", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("订单号")).toBeInTheDocument());

    expect(screen.getByTestId("list-columns-master")).toHaveClass("list-columns__toolbar");
    expect(screen.getByTestId("list-columns-detail")).toHaveClass("list-columns__detail");
  });

  it("默认展示第一个列表的全部列，所有列均可隐藏（无锁定）", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("订单号")).toBeInTheDocument());
    expect(screen.getByText("对方 / 来源")).toBeInTheDocument();
    // 身份列 order_no 的隐藏按钮不再被禁用
    expect(screen.getByRole("button", { name: "显示_order_no" })).not.toBeDisabled();
  });

  it("隐藏列：提交整表且该列 is_visible=false", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "显示_party" }));

    await waitFor(() => expect(listColumnsApi.save).toHaveBeenCalled());
    const [scope, items] = vi.mocked(listColumnsApi.save).mock.calls[0];
    expect(scope).toBe("LEDGER");
    expect(items.find((item) => item.key === "party")?.is_visible).toBe(false);
    expect(items.map((item) => item.key)).toEqual(["order_no", "party", "actions"]);
  });

  it("下移列：提交顺序随数组位置变化", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "下移_party" }));

    await waitFor(() => expect(listColumnsApi.save).toHaveBeenCalled());
    const [, items] = vi.mocked(listColumnsApi.save).mock.calls[0];
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

  it("保存后切走再切回，仍显示刚保存的列配置（不被首次加载快照覆盖）", async () => {
    // 后端保存结果：party 被隐藏。首次 all() 仍是旧快照（party 可见）。
    const savedLedger: ListScopeConfig = {
      ...ledger,
      columns: ledger.columns.map((column) =>
        column.key === "party" ? { ...column, is_visible: false } : column,
      ),
    };
    vi.mocked(listColumnsApi.all).mockResolvedValue([ledger, inventory]);
    vi.mocked(listColumnsApi.save).mockResolvedValue(savedLedger);
    renderLight(<ListColumnsPanel />, { user: "admin" });
    await waitFor(() => expect(screen.getByText("订单号")).toBeInTheDocument());

    // 隐藏 party 并保存，回填后该行应显示「已隐藏」。
    await userEvent.click(screen.getByRole("button", { name: "显示_party" }));
    await waitFor(() => expect(listColumnsApi.save).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        within(screen.getByText("对方 / 来源").closest("tr") as HTMLElement).getByText("已隐藏"),
      ).toBeInTheDocument(),
    );

    const master = screen.getByTestId("list-columns-master");
    // 切到库存中心。
    await userEvent.click(within(master).getByRole("combobox"));
    await userEvent.click(await screen.findByTitle("库存中心"));
    await waitFor(() => expect(screen.getByText("库存编号")).toBeInTheDocument());
    // 切回订单台账：应仍是刚保存的「已隐藏」，而非回退成首次快照的「显示」。
    await userEvent.click(within(master).getByRole("combobox"));
    await userEvent.click(await screen.findByTitle("订单台账"));
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());
    const partyRow = screen.getByText("对方 / 来源").closest("tr") as HTMLElement;
    expect(within(partyRow).getByText("已隐藏")).toBeInTheDocument();
  });

  it("固定列：选中后随整表提交", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("combobox", { name: "固定_party" }));
    await userEvent.click(await screen.findByTitle("固定左侧"));
    await waitFor(() => expect(listColumnsApi.save).toHaveBeenCalledTimes(1));
    const lastItems = vi.mocked(listColumnsApi.save).mock.calls[0][1];
    expect(lastItems.find((item) => item.key === "party")?.fixed).toBe("left");
  });

  it("全部显示：一次提交把所有列设为可见", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "显示_party" }));
    await waitFor(() => expect(listColumnsApi.save).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "显示全部列" }));
    await waitFor(() => expect(listColumnsApi.save).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(listColumnsApi.save).mock.calls;
    expect(calls[calls.length - 1][1].every((item) => item.is_visible)).toBe(true);
  });

  it("恢复默认：二次确认后清空该列表配置并回填默认列", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "恢复默认列配置" }));
    await userEvent.click(await screen.findByText("确认恢复"));

    await waitFor(() => expect(listColumnsApi.reset).toHaveBeenCalledWith("LEDGER"));
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
      expect(listColumnsApi.addCustom).toHaveBeenCalledWith("LEDGER", "vip_tag", ""),
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
      expect(listColumnsApi.addCustom).toHaveBeenCalledWith("LEDGER", "vip_tag", "会员等级"),
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
      expect(listColumnsApi.addCustom).toHaveBeenCalledWith("LEDGER", "qa500_note", ""),
    );
  });

  it("删除自定义列：二次确认后调用 removeCustom 并从列表移除", async () => {
    vi.mocked(listColumnsApi.all).mockResolvedValue([ledgerWithCustom, inventory]);
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("VIP 标签")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "删除_extra:vip_tag" }));
    await userEvent.click(await screen.findByText("确认删除"));

    await waitFor(() =>
      expect(listColumnsApi.removeCustom).toHaveBeenCalledWith(
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

    await waitFor(() => expect(listColumnsApi.save).toHaveBeenCalledTimes(1));
    const [scope, items] = vi.mocked(listColumnsApi.save).mock.calls[0];
    expect(scope).toBe("LEDGER");
    const party = (items as Array<{ key: string; is_visible: boolean }>).find(
      (item) => item.key === "party",
    );
    expect(party?.is_visible).toBe(false);
  });

  it("批量隐藏：锁定列（身份列）勾选后同样生效，不再静默跳过（#15）", async () => {
    renderLight(<ListColumnsPanel />);
    await waitFor(() => expect(screen.getByText("对方 / 来源")).toBeInTheDocument());

    // 与「所有列均可隐藏」口径一致：身份列勾选框保持可选
    const orderRow = screen.getByText("订单号").closest("tr") as HTMLElement;
    const orderCheckbox = orderRow.querySelector('input[type="checkbox"]') as HTMLElement;
    expect(orderCheckbox).not.toBeDisabled();
    await userEvent.click(orderCheckbox);

    await userEvent.click(screen.getByRole("button", { name: "隐藏所选列" }));

    await waitFor(() => expect(listColumnsApi.save).toHaveBeenCalledTimes(1));
    const [scope, items] = vi.mocked(listColumnsApi.save).mock.calls[0];
    expect(scope).toBe("LEDGER");
    const orderNo = (items as Array<{ key: string; is_visible: boolean }>).find(
      (item) => item.key === "order_no",
    );
    expect(orderNo?.is_visible).toBe(false);
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

    await waitFor(() => expect(listColumnsApi.save).toHaveBeenCalledTimes(1));
    const [, items] = vi.mocked(listColumnsApi.save).mock.calls[0];
    const order = (items as Array<{ key: string }>).map((item) => item.key);
    expect(order[0]).toBe("actions");
    expect(order.indexOf("order_no")).toBe(1);
  });
});
