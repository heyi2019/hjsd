import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined } from "@ant-design/icons";
import { Image, Space } from "antd";
import { useLayoutEffect, useRef, useState } from "react";
import { useKeyedLatestRequest, useRequestSession } from "../../shared/hooks/useLatestRequest";
import { appMessage } from "../../shared/ui/appFeedback";
import { normalizeError } from "../../shared/api/client";
import { useImageOriginalLoader, type AccountImageField } from "./imageOriginalContext";

type OrderDetailImageGalleryProps = {
  images: string[];
  altPrefix: string;
  limit?: number;
  editing?: boolean;
  onChange?: (images: string[]) => void;
  ownerKey?: string | number | null;
  field?: AccountImageField;
  loadOriginal?: (index: number) => Promise<string>;
};

type ImageEntry = { id: number; src: string };

/** 详情只读图片统一展示：空值用短横线，有值展示缩略图并支持预览。 */
export function OrderDetailImageGallery({ images, altPrefix, limit = 3, editing = false, onChange, ownerKey, field, loadOriginal }: OrderDetailImageGalleryProps) {
  const visibleImages = images.slice(0, limit);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewSource, setPreviewSource] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const originalLoader = useImageOriginalLoader();
  const previewSession = useRequestSession(ownerKey);
  const nextImageId = useRef(0);
  const currentImages = useRef<ImageEntry[] | null>(null);
  if (currentImages.current === null) currentImages.current = images.map((src) => ({ id: ++nextImageId.current, src }));
  const session = useRequestSession(editing ? ownerKey ?? "editing" : null);
  const replacements = useKeyedLatestRequest<number>();
  useLayoutEffect(() => {
    previewSession.invalidate();
    setPreviewLoading(false);
    setPreviewVisible(false);
    setPreviewSource("");
  }, [images, previewSession]);
  useLayoutEffect(() => {
    const remaining = [...(currentImages.current ?? [])];
    currentImages.current = images.map((src) => {
      const index = remaining.findIndex((entry) => entry.src === src);
      return index >= 0 ? remaining.splice(index, 1)[0] : { id: ++nextImageId.current, src };
    });
  }, [images]);
  if (!editing && !visibleImages.length) return "-";

  const openPreview = async (index: number) => {
    const version = previewSession.start();
    setPreviewLoading(true);
    try {
      const source = loadOriginal ? await loadOriginal(index)
        : !editing && field && originalLoader ? await originalLoader(field, index)
          : visibleImages[index];
      if (!previewSession.isCurrent(version)) return;
      setPreviewSource(source);
      setPreviewVisible(true);
    } catch (error) {
      if (previewSession.isCurrent(version)) appMessage.error(normalizeError(error).message || "原图加载失败，请重试");
    } finally {
      if (previewSession.isCurrent(version)) setPreviewLoading(false);
    }
  };

  const readImageData = (file: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });

  const appendImages = async (files: FileList | null) => {
    if (!files?.length) return;
    const token = session.current();
    try {
      const nextImages = await Promise.all(Array.from(files).map(readImageData));
      if (!session.isCurrent(token)) return;
      const next = [...(currentImages.current ?? []), ...nextImages.map((src) => ({ id: ++nextImageId.current, src }))].slice(0, limit);
      currentImages.current = next;
      onChange?.(next.map((entry) => entry.src));
    } catch {
      // 文件读取失败由浏览器直接阻止，不改变当前草稿。
    }
  };

  const replaceImage = async (index: number, file: File | undefined) => {
    if (!file) return;
    const original = currentImages.current?.[index];
    if (!original) return;
    const token = session.current();
    const version = replacements.start(original.id);
    try {
      const data = await readImageData(file);
      if (!session.isCurrent(token) || !replacements.isCurrent(original.id, version)) return;
      const currentIndex = currentImages.current?.findIndex((entry) => entry.id === original.id) ?? -1;
      if (currentIndex < 0) return;
      const nextImages = currentImages.current!.slice();
      nextImages[currentIndex] = { ...original, src: data };
      currentImages.current = nextImages;
      onChange?.(nextImages.map((entry) => entry.src));
    } catch {
      // 文件读取失败由浏览器直接阻止，不改变当前草稿。
    }
  };

  return (
    <Image.PreviewGroup
      items={previewSource ? [previewSource] : []}
      preview={{
        visible: previewVisible,
        onVisibleChange: setPreviewVisible,
      }}
    >
      <Space wrap className="order-detail__image-gallery">
        {visibleImages.map((src, index) => (
          <span key={`${altPrefix}-${src}-${index}`} className="order-detail__image-card">
            <Image src={src} alt={`${altPrefix} ${index + 1}`} preview={false} onClick={() => { if (!previewLoading) void openPreview(index); }} />
            <span className="order-detail__image-actions">
              <button
                type="button"
                className="order-detail__image-action"
                aria-label={`预览${altPrefix} ${index + 1}`}
                disabled={previewLoading}
                onClick={() => void openPreview(index)}
              >
                <EyeOutlined />
              </button>
              {editing ? (
                <>
                  <label className="order-detail__image-action" title={`替换${altPrefix} ${index + 1}`}>
                    <EditOutlined />
                    <input
                      className="order-detail__image-file-input"
                      type="file"
                      accept="image/*"
                      aria-label={`替换${altPrefix} ${index + 1}`}
                      onChange={(event) => {
                        void replaceImage(index, event.currentTarget.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="order-detail__image-action"
                    aria-label={`删除${altPrefix} ${index + 1}`}
                    onClick={() => {
                      const removed = currentImages.current?.[index];
                      if (removed) replacements.invalidate(removed.id);
                      const next = (currentImages.current ?? []).filter((_, imageIndex) => imageIndex !== index);
                      currentImages.current = next;
                      onChange?.(next.map((entry) => entry.src));
                    }}
                  >
                    <DeleteOutlined />
                  </button>
                </>
              ) : null}
            </span>
          </span>
        ))}
        {editing && images.length < limit ? (
          <label className="order-detail__image-upload">
            <PlusOutlined />
            <span>上传图片</span>
            <input
              className="order-detail__image-file-input"
              type="file"
              accept="image/*"
              multiple
              aria-label={`上传${altPrefix}`}
              onChange={(event) => {
                void appendImages(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          </label>
        ) : null}
        {editing && !visibleImages.length ? <span className="order-detail__image-empty">暂无图片</span> : null}
      </Space>
    </Image.PreviewGroup>
  );
}
