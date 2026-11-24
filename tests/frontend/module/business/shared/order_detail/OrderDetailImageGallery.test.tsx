import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderDetailImageGallery } from "@/business/shared/order_detail/OrderDetailImageGallery";
import { appMessage } from "@/shared/ui/appFeedback";
import { renderLight } from "@fixtures/render";

afterEach(() => vi.restoreAllMocks());

describe("OrderDetailImageGallery", () => {
  it("缩略图只在点击预览后请求对应原图", async () => {
    const loadOriginal = vi.fn().mockResolvedValue("data:image/png;base64,original");
    renderLight(<OrderDetailImageGallery images={["data:image/jpeg;base64,thumbnail"]} altPrefix="图片" loadOriginal={loadOriginal} />, { user: "admin" });
    expect(loadOriginal).not.toHaveBeenCalled();
    expect(screen.getByAltText("图片 1")).toHaveAttribute("src", "data:image/jpeg;base64,thumbnail");
    fireEvent.click(screen.getByAltText("图片 1"));
    await waitFor(() => expect(loadOriginal).toHaveBeenCalledWith(0));
    await waitFor(() => expect(document.querySelector(".ant-image-preview-img")).toHaveAttribute("src", "data:image/png;base64,original"));
  });
  it("图片更新后忽略尚未返回的旧原图", async () => {
    let finish!: (value: string) => void;
    const loadOriginal = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const { rerender } = renderLight(<OrderDetailImageGallery images={["old"]} altPrefix="图片" loadOriginal={loadOriginal} />, { user: "admin" });
    fireEvent.click(screen.getByAltText("图片 1"));
    rerender(<OrderDetailImageGallery images={["new"]} altPrefix="图片" loadOriginal={loadOriginal} />);
    await act(async () => finish("old-original"));
    expect(document.querySelector(".ant-image-preview-img")).toBeNull();
  });
  it("相同图片重复出现时，替换指定位置不会改错另一张", async () => {
    const onChange = vi.fn();
    const duplicate = "data:image/png;base64,same";
    const replacement = new File(["replacement"], "replacement.png", { type: "image/png" });
    renderLight(<OrderDetailImageGallery images={[duplicate, duplicate]} altPrefix="图片" editing onChange={onChange} />, { user: "admin" });
    await userEvent.setup({ pointerEventsCheck: 0 }).upload(screen.getByLabelText("替换图片 2"), replacement);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const [nextImages] = onChange.mock.calls[0] as [string[]];
    expect(nextImages[0]).toBe(duplicate);
    expect(nextImages[1]).not.toBe(duplicate);
  });
  it("相同图片同时替换时，两张图片都保留各自的结果", async () => {
    const readers: FileReader[] = [];
    vi.spyOn(globalThis, "FileReader").mockImplementation(function () {
      const reader = { readAsDataURL: () => undefined, result: `data:image/png;base64,new-${readers.length + 1}` } as unknown as FileReader;
      readers.push(reader);
      return reader;
    });
    const onChange = vi.fn();
    const duplicate = "data:image/png;base64,same";
    renderLight(<OrderDetailImageGallery images={[duplicate, duplicate]} altPrefix="图片" editing onChange={onChange} />, { user: "admin" });
    fireEvent.change(screen.getByLabelText("替换图片 1"), { target: { files: [new File(["1"], "1.png", { type: "image/png" })] } });
    fireEvent.change(screen.getByLabelText("替换图片 2"), { target: { files: [new File(["2"], "2.png", { type: "image/png" })] } });
    await act(async () => readers[1].onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>));
    await act(async () => readers[0].onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>));
    expect(onChange).toHaveBeenLastCalledWith(["data:image/png;base64,new-1", "data:image/png;base64,new-2"]);
  });
  it("替换图片读取期间删除其他图片，不会把已删除的图片恢复", async () => {
    const readers: FileReader[] = [];
    vi.spyOn(globalThis, "FileReader").mockImplementation(function () {
      const reader = { readAsDataURL: () => undefined, result: "data:image/png;base64,replacement" } as unknown as FileReader;
      readers.push(reader);
      return reader;
    });
    const onChange = vi.fn();
    const first = "data:image/png;base64,first";
    const second = "data:image/png;base64,second";
    const { rerender } = renderLight(<OrderDetailImageGallery images={[first, second]} altPrefix="图片" editing onChange={onChange} />, { user: "admin" });
    fireEvent.change(screen.getByLabelText("替换图片 2"), { target: { files: [new File(["x"], "new.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByLabelText("删除图片 1"));
    expect(onChange).toHaveBeenCalledWith([second]);
    rerender(<OrderDetailImageGallery images={[second]} altPrefix="图片" editing onChange={onChange} />);
    await act(async () => readers[0].onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>));
    expect(onChange).toHaveBeenLastCalledWith(["data:image/png;base64,replacement"]);
  });
  it("连续上传的图片读取顺序不同，也保留所有图片", async () => {
    const readers: FileReader[] = [];
    vi.spyOn(globalThis, "FileReader").mockImplementation(function () {
      const reader = { readAsDataURL: () => undefined, result: `data:image/png;base64,${readers.length + 1}` } as unknown as FileReader;
      readers.push(reader);
      return reader;
    });
    const onChange = vi.fn();
    renderLight(<OrderDetailImageGallery images={[]} altPrefix="图片" editing onChange={onChange} />, { user: "admin" });
    const input = screen.getByLabelText("上传图片");
    fireEvent.change(input, { target: { files: [new File(["1"], "1.png", { type: "image/png" })] } });
    fireEvent.change(input, { target: { files: [new File(["2"], "2.png", { type: "image/png" })] } });
    await act(async () => readers[1].onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>));
    await act(async () => readers[0].onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>));
    expect(onChange).toHaveBeenLastCalledWith(["data:image/png;base64,2", "data:image/png;base64,1"]);
  });
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
    const warning = vi.spyOn(appMessage, "warning").mockImplementation(() => undefined as never);
    const first = new File(["first"], "first.svg", { type: "image/svg+xml" });
    const second = new File(["second"], "second.svg", { type: "image/svg+xml" });
    const third = new File(["third"], "third.svg", { type: "image/svg+xml" });

    renderLight(<OrderDetailImageGallery images={[]} altPrefix="钱包实名图片" limit={2} editing onChange={onChange} />, { user: "admin" });

    await user.upload(screen.getByLabelText("上传钱包实名图片"), [first, second, third]);

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const [nextImages] = onChange.mock.calls[0] as [string[]];
    expect(nextImages).toHaveLength(2);
    expect(nextImages.every((image) => image.startsWith("data:image/svg+xml;base64,"))).toBe(true);
    expect(warning).toHaveBeenCalledWith("最多添加 2 张图片，1 张未添加");
  });

  it("部分图片读取失败时保留成功图片并提示失败数量", async () => {
    const readers: FileReader[] = [];
    vi.spyOn(globalThis, "FileReader").mockImplementation(function () {
      const reader = { readAsDataURL: () => undefined, result: "data:image/png;base64,ok" } as unknown as FileReader;
      readers.push(reader);
      return reader;
    });
    const error = vi.spyOn(appMessage, "error").mockImplementation(() => undefined as never);
    const onChange = vi.fn();
    renderLight(<OrderDetailImageGallery images={[]} altPrefix="图片" editing onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("上传图片"), { target: { files: [new File(["1"], "1.png"), new File(["2"], "2.png")] } });
    await act(async () => {
      readers[0].onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
      readers[1].onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>);
    });
    expect(onChange).toHaveBeenCalledWith(["data:image/png;base64,ok"]);
    expect(error).toHaveBeenCalledWith("1 张图片读取失败，请重新选择");
  });

  it("替换图片读取失败时保留原图并提示", async () => {
    let reader!: FileReader;
    vi.spyOn(globalThis, "FileReader").mockImplementation(function () {
      reader = { readAsDataURL: () => undefined } as unknown as FileReader;
      return reader;
    });
    const error = vi.spyOn(appMessage, "error").mockImplementation(() => undefined as never);
    const onChange = vi.fn();
    renderLight(<OrderDetailImageGallery images={["old"]} altPrefix="图片" editing onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("替换图片 1"), { target: { files: [new File(["1"], "1.png")] } });
    await act(async () => reader.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>));
    expect(onChange).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("图片读取失败，请重新选择");
  });
});
