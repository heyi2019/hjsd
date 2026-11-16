import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { OrderDetailImageGallery } from "@/orders/OrderDetailView/OrderDetailImageGallery";

describe("OrderDetailImageGallery", () => {
  it("编辑时可以替换指定位置的图片，并保留其他图片", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    const firstImage = "data:image/svg+xml;base64,first";
    const secondImage = "data:image/svg+xml;base64,second";
    const replacement = new File(["replacement"], "replacement.svg", { type: "image/svg+xml" });

    renderLight(
      <OrderDetailImageGallery
        images={[firstImage, secondImage]}
        altPrefix="二次图片"
        editing
        onChange={onChange}
      />,
      { user: "admin" },
    );

    await user.upload(screen.getByLabelText("替换二次图片 2"), replacement);

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const [nextImages] = onChange.mock.calls[0] as [string[]];
    expect(nextImages).toHaveLength(2);
    expect(nextImages[0]).toBe(firstImage);
    expect(nextImages[1]).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("编辑时可以一次追加多张图片，并受图片数量上限约束", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    const first = new File(["first"], "first.svg", { type: "image/svg+xml" });
    const second = new File(["second"], "second.svg", { type: "image/svg+xml" });
    const third = new File(["third"], "third.svg", { type: "image/svg+xml" });

    renderLight(
      <OrderDetailImageGallery images={[]} altPrefix="钱包实名图片" limit={2} editing onChange={onChange} />,
      { user: "admin" },
    );

    await user.upload(screen.getByLabelText("上传钱包实名图片"), [first, second, third]);

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const [nextImages] = onChange.mock.calls[0] as [string[]];
    expect(nextImages).toHaveLength(2);
    expect(nextImages.every((image) => image.startsWith("data:image/svg+xml;base64,"))).toBe(true);
  });
});
