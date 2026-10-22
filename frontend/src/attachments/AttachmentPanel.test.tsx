import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  vi.mocked(catalog.attachmentsApi.download).mockResolvedValue(new Blob(["x"]));
  vi.mocked(catalog.attachmentsApi.remove).mockResolvedValue(undefined);
  // jsdom 没有 URL.createObjectURL
  URL.createObjectURL = vi.fn().mockReturnValue("blob:x");
  URL.revokeObjectURL = vi.fn();
});

describe("AttachmentPanel：附件中心", () => {
  it("输入对象编号后查询展示附件列表", async () => {
    renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText("对象编号"), "100");
    await ui.click(screen.getByRole("button", { name: /查询/ }));
    expect(await screen.findByText("ATT-1")).toBeInTheDocument();
  });

  it("查询失败展示错误横幅", async () => {
    vi.mocked(catalog.attachmentsApi.list).mockRejectedValue(new Error("attach down"));
    renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText("对象编号"), "100");
    await ui.click(screen.getByRole("button", { name: /查询/ }));
    expect(await screen.findByText(/attach down/)).toBeInTheDocument();
  });

  it("未输入对象编号仅警告不发起请求", async () => {
    renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: /查询/ }));
    expect(catalog.attachmentsApi.list).not.toHaveBeenCalled();
  });

  it("点击下载调用接口并触发下载", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText("对象编号"), "100");
    await ui.click(screen.getByRole("button", { name: /查询/ }));
    await screen.findByText("ATT-1");
    await ui.click(screen.getByRole("button", { name: /下载/ }));
    await waitFor(() => expect(catalog.attachmentsApi.download).toHaveBeenCalledWith(1));
    clickSpy.mockRestore();
  });
});
