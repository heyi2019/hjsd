import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderAttachments } from "@/business/shared/order-detail/OrderAttachments";
import { attachmentsApi } from "@/shared/api/misc.api";
import { renderLight } from "@fixtures/render";

afterEach(() => vi.restoreAllMocks());

describe("订单附件", () => {
  it("重复内容提示后可确认继续上传", async () => {
    vi.spyOn(attachmentsApi, "list").mockResolvedValue({ items: [] });
    const create = vi.spyOn(attachmentsApi, "create").mockRejectedValueOnce({
      isAxiosError: true, response: { status: 409, data: { code: "DUPLICATE_ATTACHMENT", message: "附件内容重复" } },
    }).mockResolvedValueOnce({ id: 1, attachment_no: "ATT0001", file_name: "凭证.txt", size_bytes: 5, created_by: "admin" } as never);
    renderLight(<OrderAttachments orderNo="HS0001" />, { user: "admin" });
    await userEvent.click(screen.getByRole("button", { name: "查看订单附件" }));
    await userEvent.upload(screen.getByLabelText("上传订单附件"), new File(["proof"], "凭证.txt", { type: "text/plain" }));
    expect(await screen.findByText(/已有相同内容的附件/)).toBeVisible();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ entity_type: "order", entity_id: "HS0001", allow_duplicate: false });
    await userEvent.click(screen.getByRole("button", { name: "继续上传" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][0]).toMatchObject({ entity_id: "HS0001", allow_duplicate: true });
    await waitFor(() => expect(screen.queryByText(/已有相同内容的附件/)).not.toBeInTheDocument());
  });

  it("重复内容提示后取消，不会再提交上传", async () => {
    vi.spyOn(attachmentsApi, "list").mockResolvedValue({ items: [] });
    const create = vi.spyOn(attachmentsApi, "create").mockRejectedValue({
      isAxiosError: true, response: { status: 409, data: { code: "DUPLICATE_ATTACHMENT", message: "附件内容重复" } },
    });
    renderLight(<OrderAttachments orderNo="HS0001" />, { user: "admin" });
    await userEvent.click(screen.getByRole("button", { name: "查看订单附件" }));
    await userEvent.upload(screen.getByLabelText("上传订单附件"), new File(["proof"], "凭证.txt", { type: "text/plain" }));
    await screen.findByText(/已有相同内容的附件/);
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText(/已有相同内容的附件/)).not.toBeInTheDocument());
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("无写权限时附件可读但不显示上传入口", async () => {
    vi.spyOn(attachmentsApi, "list").mockResolvedValue({ items: [] });
    renderLight(<OrderAttachments orderNo="HS0001" />, { user: "viewer" });
    await userEvent.click(screen.getByRole("button", { name: "查看订单附件" }));
    expect(screen.queryByLabelText("上传订单附件")).not.toBeInTheDocument();
  });
});
