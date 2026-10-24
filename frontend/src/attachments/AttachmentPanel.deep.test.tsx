import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { message } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { AttachmentPanel } from "./AttachmentPanel";
import * as catalog from "../shared/api/catalog";
import type { AttachmentItem } from "../shared/api/catalog";

vi.mock("../shared/api/catalog");

const items: AttachmentItem[] = [
  { id: 1, attachment_no: "ATT-1", file_name: "a.pdf", size_bytes: 1024, created_by: "admin" },
];

let ui: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(catalog.attachmentsApi.list).mockResolvedValue({ items });
  vi.mocked(catalog.attachmentsApi.create).mockResolvedValue({} as never);
  vi.mocked(catalog.attachmentsApi.download).mockResolvedValue(new Blob(["x"]));
  vi.mocked(catalog.attachmentsApi.remove).mockResolvedValue(undefined);
  URL.createObjectURL = vi.fn().mockReturnValue("blob:x");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(message, "warning").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "success").mockImplementation((() => undefined) as never);
  vi.spyOn(message, "error").mockImplementation((() => undefined) as never);
});

async function loadItems(entityId = "100") {
  const { container } = renderLight(<AttachmentPanel />, { user: "admin" });
  await ui.type(screen.getByPlaceholderText("对象编号"), entityId);
  await ui.click(screen.getByRole("button", { name: /查询/ }));
  await screen.findByText("ATT-1");
  return container;
}

describe("AttachmentPanel.deep", () => {
  it("上传成功：beforeUpload 调 create + 提示 + 重新加载", async () => {
    const { container } = renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText("对象编号"), "100");
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(["x"], "b.pdf", { type: "application/pdf" }));
    await waitFor(() =>
      expect(vi.mocked(catalog.attachmentsApi.create)).toHaveBeenCalledWith(
        expect.objectContaining({ entity_type: "order", entity_id: "100", file_name: "b.pdf" }),
      ),
    );
    expect(message.success).toHaveBeenCalledWith("附件已上传");
    await waitFor(() => expect(vi.mocked(catalog.attachmentsApi.list)).toHaveBeenCalledTimes(1));
  });

  it("上传失败：展示错误横幅", async () => {
    vi.mocked(catalog.attachmentsApi.create).mockRejectedValue(new Error("create fail"));
    const { container } = renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText("对象编号"), "100");
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(["x"], "b.pdf", { type: "application/pdf" }));
    expect(await screen.findByText(/create fail/)).toBeInTheDocument();
  });

  it("删除成功：ConfirmButton 确认后调 remove + 提示 + 重新加载", async () => {
    await loadItems();
    const row = (await screen.findByText("ATT-1")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /删除/ }));
    const okBtn = (await screen.findAllByRole("button", { name: /删除/ })).find(
      (b) => b.closest(".ant-popconfirm"),
    ) as HTMLButtonElement;
    await ui.click(okBtn);
    await waitFor(() => expect(vi.mocked(catalog.attachmentsApi.remove)).toHaveBeenCalledWith(1));
    expect(message.success).toHaveBeenCalledWith("附件已删除");
    await waitFor(() => expect(vi.mocked(catalog.attachmentsApi.list)).toHaveBeenCalledTimes(2));
  });

  it("删除失败：提示错误", async () => {
    vi.mocked(catalog.attachmentsApi.remove).mockRejectedValue(new Error("remove fail"));
    await loadItems();
    const row = (await screen.findByText("ATT-1")).closest("tr") as HTMLElement;
    await ui.click(within(row).getByRole("button", { name: /删除/ }));
    const okBtn = (await screen.findAllByRole("button", { name: /删除/ })).find(
      (b) => b.closest(".ant-popconfirm"),
    ) as HTMLButtonElement;
    await ui.click(okBtn);
    // 组件内 remove 已 catch 并走 setError（错误横幅），不会向外抛错触发 ConfirmButton 的 message.error。
    expect(await screen.findByText(/remove fail/)).toBeInTheDocument();
  });

  it("下载失败：展示错误横幅", async () => {
    vi.mocked(catalog.attachmentsApi.download).mockRejectedValue(new Error("download fail"));
    await loadItems();
    await ui.click(screen.getByRole("button", { name: /下载/ }));
    expect(await screen.findByText(/download fail/)).toBeInTheDocument();
  });

  it("未输入编号查询：仅警告不发起请求", async () => {
    renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: /查询/ }));
    expect(message.warning).toHaveBeenCalledWith("请输入业务对象编号");
    expect(catalog.attachmentsApi.list).not.toHaveBeenCalled();
  });

  it("查询失败展示错误横幅，点重新加载再次请求", async () => {
    vi.mocked(catalog.attachmentsApi.list).mockRejectedValueOnce(new Error("attach down"));
    renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText("对象编号"), "100");
    await ui.click(screen.getByRole("button", { name: /查询/ }));
    expect(await screen.findByText(/attach down/)).toBeInTheDocument();
    await ui.click(screen.getByRole("button", { name: /重新加载/ }));
    await waitFor(() => expect(vi.mocked(catalog.attachmentsApi.list)).toHaveBeenCalledTimes(2));
  });

  it("在编号框按 Enter 触发查询", async () => {
    renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText("对象编号"), "100{Enter}");
    await waitFor(() => expect(vi.mocked(catalog.attachmentsApi.list)).toHaveBeenCalled());
  });

  it("未输入编号时上传入口 disabled", async () => {
    const { container } = renderLight(<AttachmentPanel />, { user: "admin" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeDisabled();
  });
});
