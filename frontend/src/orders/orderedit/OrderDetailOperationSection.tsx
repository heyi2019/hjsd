import { Descriptions, Image, Space, Typography } from "antd";
import { StatusTag } from "../../shared/ui";
import { CustomFieldSection } from "../ConfigurableField";
import {
  InventoryExtraFieldsGroup,
  InventorySectionHeading,
  type OrderDetailField,
  type OrderDetailMeta,
} from "./OrderDetail.shared";

/** 板块3：运营信息 = 业务方案 / 运营自定义字段编辑表单 + 当前运营状态（寄售中 / 已下架）。 */
export function OrderDetailOperationSection({
  meta,
  editing,
}: {
  meta: OrderDetailMeta;
  editing?: boolean;
}) {
  if (editing) {
    return (
      <div className="inventory-detail__section inventory-detail__section--operation">
        <InventorySectionHeading title="运营信息" />
        <CustomFieldSection section="OPERATION" testIdSuffix="inv-edit-operation" />
        <CustomFieldSection section="BUSINESS" testIdSuffix="inv-edit-business" />
        <CustomFieldSection section="ACCOUNT_PRODUCT" testIdSuffix="inv-edit-account-product" />
        <CustomFieldSection section="FINANCE" testIdSuffix="inv-edit-finance" />
        <CustomFieldSection section="PARTICIPANT" testIdSuffix="inv-edit-participant" />
        <CustomFieldSection testIdSuffix="inv-edit" />
      </div>
    );
  }

  const extraFieldsBySection = (section: string): OrderDetailField[] => meta.orderExtras
    .filter((field) => field.section === section)
    .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value }));

  return (
    <div className="inventory-detail__section inventory-detail__section--operation">
      <div className="inventory-detail__section-heading"><Typography.Text strong>运营信息</Typography.Text></div>
      <div className="inventory-detail__meta">
        <div className="inventory-detail__meta-group">
          <div className="inventory-detail__meta-group-title">当前运营状态</div>
          <Descriptions className="inventory-detail__meta-table" size="small" bordered column={4}>
            <Descriptions.Item label="运营状态">
              <StatusTag status={meta.operationStatusLabel} color={meta.hasActiveConsignment ? "processing" : meta.operationStatusLabel === "已下架" ? "default" : "success"} label={meta.operationStatusLabel} />
            </Descriptions.Item>
            <Descriptions.Item label="运营操作人">{meta.operationOperators ?? "-"}</Descriptions.Item>
            {meta.consignmentSummary !== "-" ? <Descriptions.Item label="寄售平台 / 寄售时间" className="inventory-detail__datetime inventory-detail__multiline">{meta.consignmentSummary}</Descriptions.Item> : null}
          </Descriptions>
        </div>
        <InventoryExtraFieldsGroup section="BUSINESS" fields={extraFieldsBySection("BUSINESS")} />
        <InventoryExtraFieldsGroup section="OPERATION" fields={extraFieldsBySection("OPERATION")} />
        <div className="inventory-detail__meta-group">
          <div className="inventory-detail__meta-group-title">账号补充资料</div>
          <Descriptions className="inventory-detail__meta-table inventory-detail__long-meta" size="small" bordered column={4}>
            <Descriptions.Item label="描述" span={4}>{meta.accountDescription}</Descriptions.Item>
            {meta.secondaryImages.length ? (
              <Descriptions.Item label="二次图片" span={4}>
                <Image.PreviewGroup>
                  <Space wrap>
                    {meta.secondaryImages.slice(0, 3).map((src, index) => (
                      <Image key={`secondary-${src}-${index}`} src={src} alt={`二次图片 ${index + 1}`} width={64} height={64} preview />
                    ))}
                  </Space>
                </Image.PreviewGroup>
              </Descriptions.Item>
            ) : null}
            {meta.walletRealnameImages.length ? (
              <Descriptions.Item label="钱包实名图片" span={4}>
                <Image.PreviewGroup>
                  <Space wrap>
                    {meta.walletRealnameImages.slice(0, 3).map((src, index) => (
                      <Image key={`wallet-${src}-${index}`} src={src} alt={`钱包实名图片 ${index + 1}`} width={64} height={64} preview />
                    ))}
                  </Space>
                </Image.PreviewGroup>
              </Descriptions.Item>
            ) : null}
            <Descriptions.Item label="作图" span={4}>
              {meta.accountImages.length ? (
                <Image.PreviewGroup>
                  <Space wrap>
                    {meta.accountImages.slice(0, 9).map((src, index) => (
                      <Image key={`${src}-${index}`} src={src} alt={`作图 ${index + 1}`} width={64} height={64} preview />
                    ))}
                  </Space>
                </Image.PreviewGroup>
              ) : "-"}
            </Descriptions.Item>
          </Descriptions>
        </div>
      </div>
    </div>
  );
}
