/** StudioExpensePanel：工作室支出登记与承载池配置。 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { resolveMockOnce } from "../test/mock-api";
import * as catalog from "../shared/api/catalog";
import { StudioExpensePanel } from "./StudioExpensePanel";

let ui: ReturnType<typeof userEvent.setup>;

vi.mock("../shared/api/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api/catalog")>();
  const METHODS = [
    "list", "get", "create", "update", "patch", "post", "postEvent", "remove",
    "setStatus", "setActive", "resolve", "release", "loss", "repair", "settle", "approve", "reject",
    "reverse", "close", "convert", "detail", "allocations", "setAllocations",
    "balance", "executionDetail", "updateProfile", "updateExecution", "merge", "search",
  ];
  const mk = (api: Record<string, unknown>) => {
    const o: Record<string, unknown> = { ...api };
    for (const m of METHODS) {
      if (m in o) o[m] = vi.fn();
    }
    return o;
  };
  const out: Record<string, unknown> = { ...actual };
  for (const key of Object.keys(actual)) {
    const v = (actual as Record<string, unknown>)[key];
    if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).some((x) => typeof x === "function")) {
      out[key] = mk(v as Record<string, unknown>);
    }
  }
  return out as unknown as typeof actual;
});

const pools = [
  { id: 1, code: "POOL-A", name: "经营主池", pool_type: "OPERATING", ownership: "SELF", status: "ACTIVE" },
  { id: 2, code: "POOL-B", name: "押金池", pool_type: "DEPOSIT", ownership: "SELF", status: "ACTIVE" },
];

const expenseFlows = [
  {
    id: 51, flow_no: "CF-001", pool_id: 1, occurred_on: "2026-10-20", nature: "BUSINESS_OUT",
    category: "房租", direction: "OUT", amount: "3000.00", source: "OTHER", status: "APPROVED",
    fund_nature: "BUSINESS", accounting_attribute: "OPERATING_EXPENSE",
  },
  {
    id: 52, flow_no: "CF-002", pool_id: 2, occurred_on: "2026-10-21", nature: "BUSINESS_OUT",
    category: "日用", direction: "OUT", amount: "100.00", source: "OTHER", status: "PENDING",
    fund_nature: "BUSINESS", accounting_attribute: "OPERATING_EXPENSE",
  },
];

function mockOptionSets(poolCodes: string[]) {
  vi.mocked(catalog.optionSetsApi.get).mockImplementation(async (code: string) => {
    if (code === "STUDIO_EXPENSE_POOL") {
      if (poolCodes.length === 0) throw new Error("404 not configured");
      return {
        id: 91, code, label: "工作室支出承载资金池", group: "FUND", editable: true,
        options: poolCodes.map((value) => ({ value, label: pools.find((p) => p.code === value)?.name ?? value })),
      } as never;
    }
    if (code === "STUDIO_EXPENSE_ITEM") {
      return {
        id: 92, code, label: "工作室支出费用科目", group: "FUND", editable: true,
        options: [
          { value: "房租", label: "房租" },
          { value: "日用", label: "日用" },
        ],
      } as never;
    }
    throw new Error(`unexpected option set: ${code}`);
  });
}

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  // 列表按方向拉两次（支出=OPERATING_EXPENSE / 收入=SELF_REVENUE），mock 按参数分流
  vi.mocked(catalog.cashflowsApi.list).mockImplementation(async (params) => {
    const items = expenseFlows.filter((flow) => flow.direction === params?.direction);
    return { items, total: items.length };
  });
});

async function pickSelect(modal: HTMLElement, index: number, title: RegExp) {
  await ui.click(modal.querySelectorAll(".ant-select-selector")[index] as Element);
  const dropdowns = document.querySelectorAll(".ant-select-dropdown");
  const current = dropdowns[dropdowns.length - 1] as HTMLElement;
  await ui.click(await within(current).findByTitle(title));
}

describe("StudioExpensePanel：工作室支出", () => {
  it("未配置承载池时给出引导提示，且列表为空", async () => {
    mockOptionSets([]);
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    expect(await screen.findByText(/尚未勾选任何承载资金池/)).toBeInTheDocument();
    expect(screen.getByText("暂无工作室支出")).toBeInTheDocument();
  });

  it("列表只显示已勾选承载池的手工收支流水", async () => {
    mockOptionSets(["POOL-A"]);
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    expect(await screen.findByText("房租")).toBeInTheDocument();
    // POOL-B 上的日用支出被过滤，不出现在本页
    expect(screen.queryByText("日用")).not.toBeInTheDocument();
  });

  it("登记支出：提交即自动审核入账（OUT / BUSINESS_OUT / OPERATING_EXPENSE）", async () => {
    mockOptionSets(["POOL-A"]);
    resolveMockOnce(vi.mocked(catalog.cashflowsApi.create), { id: 61 });
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");
    await ui.click(await screen.findByRole("button", { name: /记一笔/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, /经营主池/);
    await pickSelect(modal, 2, /房租/);
    await ui.type(modal.querySelector("#amount") ?? modal, "3000.00");
    await ui.type(modal.querySelector("#note") ?? modal, "10 月工作室房租");
    await ui.click(screen.getByRole("button", { name: /登记入账/ }));
    await waitFor(() => expect(vi.mocked(catalog.cashflowsApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(catalog.cashflowsApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      pool_id: 1,
      direction: "OUT",
      nature: "BUSINESS_OUT",
      fund_nature: "BUSINESS",
      accounting_attribute: "OPERATING_EXPENSE",
      category: "房租",
      amount: "3000.00",
    });
    // 关闭审核态：create 成功后立即自动补审核
    await waitFor(() => expect(vi.mocked(catalog.cashflowsApi.approve)).toHaveBeenCalledWith(61));
  });

  it("登记收入：IN / BUSINESS_IN / SELF_REVENUE，同样自动入账", async () => {
    mockOptionSets(["POOL-A"]);
    resolveMockOnce(vi.mocked(catalog.cashflowsApi.create), { id: 62 });
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText("房租");
    await ui.click(await screen.findByRole("button", { name: /记一笔/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, /经营主池/);
    await pickSelect(modal, 1, /^收入$/);
    await pickSelect(modal, 2, /货款/);
    await ui.type(modal.querySelector("#amount") ?? modal, "800.00");
    await ui.click(screen.getByRole("button", { name: /登记入账/ }));
    await waitFor(() => expect(vi.mocked(catalog.cashflowsApi.create)).toHaveBeenCalled());
    const payload = vi.mocked(catalog.cashflowsApi.create).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      pool_id: 1,
      direction: "IN",
      nature: "BUSINESS_IN",
      fund_nature: "BUSINESS",
      accounting_attribute: "SELF_REVENUE",
      category: "货款",
      amount: "800.00",
    });
    await waitFor(() => expect(vi.mocked(catalog.cashflowsApi.approve)).toHaveBeenCalledWith(62));
  });

  it("配置承载池保存到选项词典（按池 code 存储）", async () => {
    mockOptionSets([]);
    vi.mocked(catalog.optionSetsApi.update).mockResolvedValueOnce({} as never);
    renderLight(<StudioExpensePanel pools={pools} />, { user: "admin" });
    await screen.findByText(/尚未勾选任何承载资金池/);
    await ui.click(await screen.findByRole("button", { name: /配置承载池/ }));
    const modal = document.querySelector(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, /经营主池/);
    await ui.click(screen.getByRole("button", { name: /保存配置/ }));
    await waitFor(() => expect(vi.mocked(catalog.optionSetsApi.update)).toHaveBeenCalled());
    const [code, payload] = vi.mocked(catalog.optionSetsApi.update).mock.calls[0];
    expect(code).toBe("STUDIO_EXPENSE_POOL");
    expect((payload as { options: Array<{ value: string }> }).options.map((o) => o.value)).toEqual(["POOL-A"]);
  });
});
