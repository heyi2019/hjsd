import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { InventoryProfileModal, type InventoryProfileTarget } from "@/orders/operations";
import { stocksApi } from "@/shared/api/stocks.api";
import type { Account } from "@/shared/api/types/accounts";

vi.mock("@/shared/api/cashflows.api");
vi.mock("@/shared/api/customers.api");
vi.mock("@/shared/api/installments.api");
vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/options.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/policy.api");
vi.mock("@/shared/api/pools.api");
vi.mock("@/shared/api/quality.api");
vi.mock("@/shared/api/rebates.api");
vi.mock("@/shared/api/reports.api");
vi.mock("@/shared/api/stocks.api");;

let ui: ReturnType<typeof userEvent.setup>;

const account = {
  id: 7,
  game_account: "acc-001",
  game_type: "原神",
  game_password: "pwd",
  channel_region: "天空岛",
  bound_phone: "13800000000",
  platform: "安卓",
  has_secondary: false,
  account_description: "初始描述",
  account_images: [] as string[],
  note: "",
} as unknown as Account;

const updated = { ...account, account_description: "已更新" } as unknown as Account;

let onClose: () => void;
let onSaved: (account: Account) => void;
let onError: (error: unknown) => void;

function renderModal(target: InventoryProfileTarget) {
  return renderLight(
    <InventoryProfileModal target={target} onClose={onClose} onSaved={onSaved} onError={onError} />,
    { user: "admin" },
  );
}

async function attachImage(content: string, name: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([content], name, { type: "image/png" }) as File & { text: () => Promise<string> };
  file.text = () => Promise.resolve(content);
  Object.defineProperty(input, "files", { value: [file], configurable: true, writable: true });
  // rc-upload 的 processFile 是 Promise 链，必须 await act 冲刷
  await act(async () => {
    fireEvent.change(input);
  });
}

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  onClose = vi.fn();
  onSaved = vi.fn();
  onError = vi.fn();
  vi.mocked(stocksApi.updateProfile).mockResolvedValue(updated);
});

describe("InventoryProfileModal：描述与图片读取", () => {
  it("description 模式：输入描述后保存只提交 account_description", async () => {
    renderModal({ account, mode: "description" });
    expect(await screen.findByText("描述")).toBeInTheDocument();
    const area = screen.getByPlaceholderText("补充账号等级、资源、限制等信息");
    // 只读标识区与输入框约束（原 InventoryProfileModal.test.tsx 的独有断言，已并入本用例）
    for (const label of ["订单编号", "游戏类型", "游戏账号"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(area).toHaveAttribute("rows", "8");
    expect(area).toHaveAttribute("maxlength", "400");
    await ui.clear(area);
    await ui.type(area, "满级账号");
    await ui.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(stocksApi.updateProfile).toHaveBeenCalled());
    expect(vi.mocked(stocksApi.updateProfile).mock.calls[0]).toEqual([
      7,
      { account_description: "满级账号" },
    ]);
    expect(onSaved).toHaveBeenCalledWith(updated);
    expect(onClose).toHaveBeenCalled();
  });

  it("images 模式：已有图片 URL 直接沿用，不经 FileReader", async () => {
    const withImages = { ...account, account_images: ["https://cdn/1.png"] } as unknown as Account;
    renderModal({ account: withImages, mode: "images" });
    expect(await screen.findByText("作图")).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(stocksApi.updateProfile).toHaveBeenCalled());
    expect(vi.mocked(stocksApi.updateProfile).mock.calls[0][1]).toEqual({
      account_images: ["https://cdn/1.png"],
    });
  });

  it("FE-274：图片模式为空时阻止保存并提示至少添加一张图片", async () => {
    renderModal({ account, mode: "images" });
    await screen.findByText("作图");
    await ui.click(screen.getByRole("button", { name: /保存/ }));

    expect(stocksApi.updateProfile).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("请至少添加一张图片");
  });

  it("images 模式：上传新图后保存走 FileReader 生成 data URL", async () => {
    renderModal({ account, mode: "images" });
    await screen.findByText("作图");
    await attachImage("image-bytes", "shot.png");
    await ui.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(stocksApi.updateProfile).toHaveBeenCalled());
    const images = (vi.mocked(stocksApi.updateProfile).mock.calls[0][1] as { account_images: string[] })
      .account_images;
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/^data:/);
  });

  it("保存失败时回调 onError 而非 onSaved", async () => {
    vi.mocked(stocksApi.updateProfile).mockRejectedValue(new Error("save boom"));
    renderModal({ account, mode: "description" });
    await screen.findByText("描述");
    await ui.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
