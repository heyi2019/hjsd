import { Image, Space } from "antd";

type OrderDetailImageGalleryProps = {
  images: string[];
  altPrefix: string;
  limit?: number;
};

/** 详情只读图片统一展示：空值用短横线，有值展示缩略图并支持预览。 */
export function OrderDetailImageGallery({ images, altPrefix, limit = 3 }: OrderDetailImageGalleryProps) {
  const visibleImages = images.slice(0, limit);
  if (!visibleImages.length) return "-";

  return (
    <Image.PreviewGroup>
      <Space wrap>
        {visibleImages.map((src, index) => (
          <Image key={`${altPrefix}-${src}-${index}`} src={src} alt={`${altPrefix} ${index + 1}`} width={64} height={64} preview />
        ))}
      </Space>
    </Image.PreviewGroup>
  );
}
