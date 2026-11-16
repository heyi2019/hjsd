import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined } from "@ant-design/icons";
import { Image, Space } from "antd";
import { useState } from "react";

type OrderDetailImageGalleryProps = {
  images: string[];
  altPrefix: string;
  limit?: number;
  editing?: boolean;
  onChange?: (images: string[]) => void;
};

/** 详情只读图片统一展示：空值用短横线，有值展示缩略图并支持预览。 */
export function OrderDetailImageGallery({ images, altPrefix, limit = 3, editing = false, onChange }: OrderDetailImageGalleryProps) {
  const visibleImages = images.slice(0, limit);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  if (!editing && !visibleImages.length) return "-";

  const readImageData = (file: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });

  const appendImages = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const nextImages = await Promise.all(Array.from(files).map(readImageData));
      onChange?.([...images, ...nextImages].slice(0, limit));
    } catch {
      // 文件读取失败由浏览器直接阻止，不改变当前草稿。
    }
  };

  const replaceImage = async (index: number, file: File | undefined) => {
    if (!file) return;
    try {
      const data = await readImageData(file);
      const nextImages = images.slice();
      nextImages[index] = data;
      onChange?.(nextImages);
    } catch {
      // 文件读取失败由浏览器直接阻止，不改变当前草稿。
    }
  };

  return (
    <Image.PreviewGroup
      preview={{
        visible: previewVisible,
        current: previewIndex,
        onVisibleChange: setPreviewVisible,
      }}
    >
      <Space wrap className="order-detail__image-gallery">
        {visibleImages.map((src, index) => (
          <span key={`${altPrefix}-${src}-${index}`} className="order-detail__image-card">
            <Image src={src} alt={`${altPrefix} ${index + 1}`} preview={false} />
            <span className="order-detail__image-actions">
              <button
                type="button"
                className="order-detail__image-action"
                aria-label={`预览${altPrefix} ${index + 1}`}
                onClick={() => { setPreviewIndex(index); setPreviewVisible(true); }}
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
                    onClick={() => onChange?.(images.filter((_, imageIndex) => imageIndex !== index))}
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
