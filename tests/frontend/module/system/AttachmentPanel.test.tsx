import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { AttachmentPanel } from "@/attachments/AttachmentPanel";
import { attachmentsApi } from "@/shared/api/misc.api";
import type { AttachmentItem } from "@/shared/api/types/common";

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

const items: AttachmentItem[] = [
  { id: 1, attachment_no: "ATT-1", file_name: "a.pdf", size_bytes: 1024, created_by: "admin" },
];

let ui: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  ui = userEvent.setup({ pointerEventsCheck: 0 });
  vi.clearAllMocks();
  vi.mocked(attachmentsApi.list).mockResolvedValue({ items });
  vi.mocked(attachmentsApi.create).mockResolvedValue({ id: 2 } as never);
  vi.mocked(attachmentsApi.download).mockResolvedValue(new Blob(["x"]));
  vi.mocked(attachmentsApi.remove).mockResolvedValue(undefined);
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
    vi.mocked(attachmentsApi.list).mockRejectedValue(new Error("attach down"));
    renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText("对象编号"), "100");
    await ui.click(screen.getByRole("button", { name: /查询/ }));
    expect(await screen.findByText(/attach down/)).toBeInTheDocument();
  });

  it("未输入对象编号仅警告不发起请求", async () => {
    renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.click(screen.getByRole("button", { name: /查询/ }));
    expect(attachmentsApi.list).not.toHaveBeenCalled();
  });

  it("未输入对象编号时明确提示上传前置条件", async () => {
    renderLight(<AttachmentPanel />, { user: "admin" });
    expect(screen.getByText("请先填写对象编号后上传附件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /上传附件/ })).toBeDisabled();
  });

  it("FE-114/165：填写有效对象后允许选择文件并调用上传", async () => {
    renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText("对象编号"), "100");
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["fixture"], "fixture.png", { type: "image/png" });
    await ui.upload(fileInput, file);
    await waitFor(() => expect(attachmentsApi.create).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: "order",
      entity_id: "100",
      file_name: "fixture.png",
      content_type: "image/png",
    })));
  });

  it("点击下载调用接口并触发下载", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderLight(<AttachmentPanel />, { user: "admin" });
    await ui.type(screen.getByPlaceholderText("对象编号"), "100");
    await ui.click(screen.getByRole("button", { name: /查询/ }));
    await screen.findByText("ATT-1");
    await ui.click(screen.getByRole("button", { name: /下载/ }));
    await waitFor(() => expect(attachmentsApi.download).toHaveBeenCalledWith(1));
    clickSpy.mockRestore();
  });
});
