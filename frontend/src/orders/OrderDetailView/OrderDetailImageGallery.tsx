import { DeleteOutlined, EyeOutlined, PlusOutlined } from "@ant-design/icons";
import { Image, Space, Upload } from "antd";
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
                <button
                  type="button"
                  className="order-detail__image-action"
                  aria-label={`删除${altPrefix} ${index + 1}`}
                  onClick={() => onChange?.(images.filter((_, imageIndex) => imageIndex !== index))}
                >
                  <DeleteOutlined />
                </button>
              ) : null}
            </span>
          </span>
        ))}
        {editing && images.length < limit ? (
          <Upload
            accept="image/*"
            multiple
            showUploadList={false}
            beforeUpload={async (file) => {
              try {
                const data = await readImageData(file);
                onChange?.([...images, data].slice(0, limit));
              } catch {
                // 文件读取失败由浏览器直接阻止，不改变当前草稿。
              }
              return Upload.LIST_IGNORE;
            }}
          >
            <button type="button" className="order-detail__image-upload" aria-label={`上传${altPrefix}`}>
              <PlusOutlined />
              <span>上传图片</span>
            </button>
          </Upload>
        ) : null}
        {editing && !visibleImages.length ? <span className="order-detail__image-empty">暂无图片</span> : null}
      </Space>
    </Image.PreviewGroup>
  );
}
