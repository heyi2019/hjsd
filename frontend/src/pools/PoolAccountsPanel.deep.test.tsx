import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { message } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { PoolAccountsPanel } from "./PoolAccountsPanel";
import { resolveMock } from "../test/mock-api";
import * as catalog from "../shared/api/catalog";

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
});

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
const accounts = [
  { id: 1, pool_id: 1, account_no: "ABC-8678", account_name: "农行卡 8678", account_type: "BANK", ownership: "OWNED", opening_balance: "0.00", current_balance: "0.00", status: "ACTIVE", note: "主卡" },
  { id: 2, pool_id: 2, account_no: "CASH-001", account_name: "现金箱", account_type: "CASH", ownership: "CUSTODY", opening_balance: "100.00", current_balance: "100.00", status: "ACTIVE", note: null },
  { id: 3, pool_id: 999, account_no: "UNK", account_name: "未知池账户", account_type: "THIRD_PARTY", ownership: "THIRD_PART", opening_balance: "0.00", current_balance: "0.00", status: "DISABLED", note: "x" },
];

async function pickSelect(modal: HTMLElement, index: number, label: string) {
  await ui.click(modal.querySelectorAll(".ant-select-selector")[index] as Element);
  const opt = await within(document.body).findByText(label, { selector: ".ant-select-item-option-content" });
  await ui.click(opt);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.poolsApi.list).mockResolvedValue(pools);
  vi.mocked(catalog.poolAccountsApi.list).mockResolvedValue(accounts);
  vi.spyOn(message, "success").mockImplementation(() => undefined as never);
  vi.spyOn(message, "error").mockImplementation(() => undefined as never);
});

describe("PoolAccountsPanel.deep", () => {
  it("渲染：池名映射 / 无效池 #id 分支 / 归属标签 / 状态 / 备注空分支", async () => {
    renderLight(<PoolAccountsPanel />, { user: "admin" });
    expect(await screen.findByText("农行卡 8678")).toBeInTheDocument();
    expect(screen.getByText("经营主池（POOL-A）")).toBeInTheDocument();
    expect(screen.getByText("押金池（POOL-B）")).toBeInTheDocument();
    // 无效 pool_id → `#999`
    expect(screen.getByText("#999")).toBeInTheDocument();
    // 归属标签（OWNED / 非 OWNED）
    expect(screen.getByText("自有（计入权益）")).toBeInTheDocument();
    expect(screen.getByText("代管（只计头寸）")).toBeInTheDocument();
    // 状态标签（启用 / 停用）
    expect(screen.getAllByText("启用").length).toBeGreaterThan(0);
    expect(screen.getAllByText("停用").length).toBeGreaterThan(0);
    // 备注空 → `-`
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
  });

  it("新建账户成功：提交 create + 关闭弹窗 + 成功提示", async () => {
    renderLight(<PoolAccountsPanel />, { user: "admin" });
    await screen.findByText("农行卡 8678");
    await ui.click(screen.getByRole("button", { name: /新\s*建\s*账户/ }));
    const createTitle = await screen.findByText("新建池内账户");
    const modal = createTitle.closest(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, "经营主池（POOL-A）");
    await ui.type(within(modal).getByLabelText("账号编号"), "NEW-001");
    await ui.type(within(modal).getByLabelText("账户名称"), "新账户");
    await ui.click(within(modal).getByRole("button", { name: /创\s*建/ }));
    await waitFor(() =>
      expect(vi.mocked(catalog.poolAccountsApi.create)).toHaveBeenCalledWith({
        pool_id: 1,
        account_no: "NEW-001",
        account_name: "新账户",
        account_type: "BANK",
        ownership: "OWNED",
        opening_balance: "0",
        note: undefined,
      }),
    );
    expect(message.success).toHaveBeenCalledWith("池内账户已创建");
    // 提交后 reload：list 被再次调用（初始挂载 1 次 + 提交后 1 次）
    await waitFor(() => expect(vi.mocked(catalog.poolAccountsApi.list)).toHaveBeenCalledTimes(2));
  });

  it("新建账户失败：提示错误且不关闭弹窗", async () => {
    vi.mocked(catalog.poolAccountsApi.create).mockRejectedValue(new Error("dup"));
    renderLight(<PoolAccountsPanel />, { user: "admin" });
    await screen.findByText("农行卡 8678");
    await ui.click(screen.getByRole("button", { name: /新\s*建\s*账户/ }));
    const createTitle = await screen.findByText("新建池内账户");
    const modal = createTitle.closest(".ant-modal-content") as HTMLElement;
    await pickSelect(modal, 0, "经营主池（POOL-A）");
    await ui.type(within(modal).getByLabelText("账号编号"), "NEW-002");
    await ui.type(within(modal).getByLabelText("账户名称"), "新账户2");
    await ui.click(within(modal).getByRole("button", { name: /创\s*建/ }));
    await waitFor(() => expect(vi.mocked(catalog.poolAccountsApi.create)).toHaveBeenCalled());
    expect(message.error).toHaveBeenCalledWith(expect.stringMatching(/dup/));
    // 弹窗仍开
    expect(screen.getByText("新建池内账户")).toBeInTheDocument();
  });

  it("编辑提交成功：调用 update（trim + 保留其余字段）", async () => {
    renderLight(<PoolAccountsPanel />, { user: "admin" });
    const row = (await screen.findByText("农行卡 8678")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /编\s*辑/ }));
    const editTitle = await screen.findByText("编辑账户 · 农行卡 8678");
    const modal = editTitle.closest(".ant-modal-content") as HTMLElement;
    const nameInput = within(modal).getByLabelText("账户名称") as HTMLInputElement;
    await ui.clear(nameInput);
    await ui.type(nameInput, "农行卡 8678改");
    await ui.click(within(modal).getByRole("button", { name: /保\s*存/ }));
    await waitFor(() =>
      expect(vi.mocked(catalog.poolAccountsApi.update)).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ account_name: "农行卡 8678改", account_type: "BANK", ownership: "OWNED" }),
      ),
    );
    expect(message.success).toHaveBeenCalledWith("池内账户已更新");
  });

  it("编辑提交失败：提示错误", async () => {
    vi.mocked(catalog.poolAccountsApi.update).mockRejectedValue(new Error("conflict"));
    renderLight(<PoolAccountsPanel />, { user: "admin" });
    const row = (await screen.findByText("农行卡 8678")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /编\s*辑/ }));
    const editTitle = await screen.findByText("编辑账户 · 农行卡 8678");
    const modal = editTitle.closest(".ant-modal-content") as HTMLElement;
    const nameInput = within(modal).getByLabelText("账户名称") as HTMLInputElement;
    await ui.clear(nameInput);
    await ui.type(nameInput, "改名");
    await ui.click(within(modal).getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(vi.mocked(catalog.poolAccountsApi.update)).toHaveBeenCalled());
    expect(message.error).toHaveBeenCalledWith(expect.stringMatching(/conflict/));
  });

  it("停用账户（ConfirmButton）：setStatus(id, DISABLED) + 提示", async () => {
    renderLight(<PoolAccountsPanel />, { user: "admin" });
    const row = (await screen.findByText("农行卡 8678")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /停\s*用/ }));
    await ui.click(await screen.findByRole("button", { name: /确\s*认/ }));
    await waitFor(() =>
      expect(vi.mocked(catalog.poolAccountsApi.setStatus)).toHaveBeenCalledWith(1, "DISABLED"),
    );
    expect(message.success).toHaveBeenCalledWith("账户已停用");
  });

  it("启用账户（ConfirmButton）：setStatus(id, ACTIVE) + 提示", async () => {
    renderLight(<PoolAccountsPanel />, { user: "admin" });
    const row = (await screen.findByText("未知池账户")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /启\s*用/ }));
    await ui.click(await screen.findByRole("button", { name: /确\s*认/ }));
    await waitFor(() =>
      expect(vi.mocked(catalog.poolAccountsApi.setStatus)).toHaveBeenCalledWith(3, "ACTIVE"),
    );
    expect(message.success).toHaveBeenCalledWith("账户已启用");
  });

  it("按资金池筛选：onChange 重新 load 并带参", async () => {
    renderLight(<PoolAccountsPanel />, { user: "admin" });
    await screen.findByText("农行卡 8678");
    await ui.click(screen.getByRole("combobox", { name: /按资金池筛选/ }));
    await ui.click(await within(document.body).getByText("经营主池（POOL-A）", { selector: ".ant-select-item-option-content" }));
    await waitFor(() =>
      expect(vi.mocked(catalog.poolAccountsApi.list)).toHaveBeenLastCalledWith(1),
    );
  });

  it("加载失败：ErrorBanner + 重新加载重试成功", async () => {
    vi.mocked(catalog.poolAccountsApi.list)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(accounts);
    renderLight(<PoolAccountsPanel />, { user: "admin" });
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /重\s*新\s*加载/ }));
    await waitFor(() => expect(vi.mocked(catalog.poolAccountsApi.list)).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("农行卡 8678")).toBeInTheDocument();
  });
});
