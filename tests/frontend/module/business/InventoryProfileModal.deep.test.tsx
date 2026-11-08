import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { InventoryProfileModal, type InventoryProfileTarget } from "@/stocks/InventoryProfileModal";
import * as catalog from "@/shared/api/catalog";
import type { Account } from "@/shared/api/catalog";

vi.mock("@/shared/api/catalog");

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

function modalEl(): HTMLElement {
  return document.querySelector(".ant-modal-content") as HTMLElement;
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
  vi.mocked(catalog.stocksApi.updateProfile).mockResolvedValue(updated);
});

describe("InventoryProfileModal：三档模式与图片读取", () => {
  it("description 模式：输入描述后保存只提交 account_description", async () => {
    renderModal({ account, mode: "description" });
    expect(await screen.findByText("描述")).toBeInTheDocument();
    const area = screen.getByPlaceholderText("补充账号等级、资源、限制等信息");
    for (const label of ["订单编号", "游戏类型", "游戏账号"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(area).toHaveAttribute("rows", "8");
    expect(area).toHaveAttribute("maxlength", "400");
    await ui.clear(area);
    await ui.type(area, "满级账号");
    await ui.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(catalog.stocksApi.updateProfile).toHaveBeenCalled());
    expect(vi.mocked(catalog.stocksApi.updateProfile).mock.calls[0]).toEqual([
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
    await waitFor(() => expect(catalog.stocksApi.updateProfile).toHaveBeenCalled());
    expect(vi.mocked(catalog.stocksApi.updateProfile).mock.calls[0][1]).toEqual({
      account_images: ["https://cdn/1.png"],
    });
  });

  it("FE-274：图片模式为空时阻止保存并提示至少添加一张图片", async () => {
    renderModal({ account, mode: "images" });
    await screen.findByText("作图");
    await ui.click(screen.getByRole("button", { name: /保存/ }));

    expect(catalog.stocksApi.updateProfile).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("请至少添加一张图片");
  });

  it("images 模式：上传新图后保存走 FileReader 生成 data URL", async () => {
    renderModal({ account, mode: "images" });
    await screen.findByText("作图");
    await attachImage("image-bytes", "shot.png");
    await ui.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(catalog.stocksApi.updateProfile).toHaveBeenCalled());
    const images = (vi.mocked(catalog.stocksApi.updateProfile).mock.calls[0][1] as { account_images: string[] })
      .account_images;
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/^data:/);
  });

  it("all 模式：预填账号字段并整体提交", async () => {
    renderModal({ account, mode: "all" });
    expect(await screen.findByText("编辑账号资料")).toBeInTheDocument();
    expect(screen.getByLabelText("游戏账号/产品")).toHaveValue("acc-001");
    const typeInput = screen.getByLabelText("游戏/产品类型");
    await ui.clear(typeInput);
    await ui.type(typeInput, "星穹铁道");
    await ui.type(screen.getByLabelText("绑定手机号"), "9");
    await ui.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(catalog.stocksApi.updateProfile).toHaveBeenCalled());
    const [id, payload] = vi.mocked(catalog.stocksApi.updateProfile).mock.calls[0] as [
      number,
      Record<string, unknown>,
    ];
    expect(id).toBe(7);
    expect(payload.game_type).toBe("星穹铁道");
    expect(payload.bound_phone).toBe("138000000009");
    expect(payload.platform).toBe("安卓");
    expect(payload.has_secondary).toBe(false);
    expect(payload.account_description).toBe("初始描述");
  });

  it("all 模式：切换有无二次 Select 写入 has_secondary", async () => {
    renderModal({ account, mode: "all" });
    await screen.findByText("编辑账号资料");
    await ui.click(modalEl().querySelector(".ant-select-selector") as HTMLElement);
    await ui.click(await screen.findByText("有二次", { selector: ".ant-select-item-option-content" }));
    await ui.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(catalog.stocksApi.updateProfile).toHaveBeenCalled());
    const payload = vi.mocked(catalog.stocksApi.updateProfile).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.has_secondary).toBe(true);
  });

  it("all 模式：账号自带图片预填到最多 9 张", async () => {
    const many = {
      ...account,
      account_images: Array.from({ length: 11 }, (_, i) => `https://cdn/${i}.png`),
    } as unknown as Account;
    renderModal({ account: many, mode: "all" });
    await screen.findByText("编辑账号资料");
    const modal = modalEl();
    expect(within(modal).getAllByText(/作图\d/).length).toBe(9);
  });

  it("保存失败时回调 onError 而非 onSaved", async () => {
    vi.mocked(catalog.stocksApi.updateProfile).mockRejectedValue(new Error("save boom"));
    renderModal({ account, mode: "description" });
    await screen.findByText("描述");
    await ui.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
