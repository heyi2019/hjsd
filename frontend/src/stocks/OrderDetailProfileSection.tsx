import { Descriptions, Image, Input, Space, Typography } from "antd";
import type { Account } from "../shared/api/catalog";
import { MoneyText } from "../shared/ui";
import {
  InventoryExtraFieldsGroup,
  InventorySectionHeading,
  type OrderDetailField,
  type OrderDetailMeta,
} from "./OrderDetail.shared";
import { OrderDetailEditFields } from "./OrderDetailEditFields";

/** 板块1：游戏账号信息 = 账号基本资料 + 登记与流转 + 各 section 自定义字段 + 账号补充资料（只读）/ 编辑表单。 */
export function OrderDetailProfileSection({
  meta,
  editing,
  account,
  onEdit,
}: {
  meta: OrderDetailMeta;
  editing?: boolean;
  account?: Account | null;
  onEdit?: (account: Account) => void;
}) {
  const basicFields: OrderDetailField[] = [
    { key: "inventoryNo", label: "库存编号", value: meta.inventoryNo ?? "-" },
    { key: "status", label: "状态", value: meta.statusLabel ?? "-" },
    { key: "gameType", label: "游戏 / 产品类型", value: meta.gameType || "-" },
    { key: "gameAccount", label: "游戏账号 / 产品", value: meta.gameAccount || "-" },
    { key: "platform", label: "平台", value: meta.platform || "-" },
    { key: "cost", label: "成本", value: meta.cost ? <MoneyText value={meta.cost} /> : "-" },
    { key: "businessMode", label: "业务", value: meta.businessMode || "-" },
    { key: "inventoryType", label: "业务类型", value: meta.inventoryType || "-" },
    { key: "valueAddedService", label: "增值服务", value: meta.valueAddedService || "-" },
  ];
  // 编辑态可改的核心三项（与保存逻辑 profile 字段对齐：game_account / game_type / platform）。
  const EDITABLE_BASIC_KEYS = new Set(["gameAccount", "gameType", "platform"]);
  const EDITABLE_BASIC_LABEL: Record<string, string> = {
    gameAccount: "编辑游戏账号/产品",
    gameType: "编辑游戏/产品类型",
    platform: "编辑平台",
  };
  const basicEditable = basicFields.filter((field) => EDITABLE_BASIC_KEYS.has(field.key));
  const basicReadOnly = basicFields.filter((field) => !EDITABLE_BASIC_KEYS.has(field.key));
  const registrationFields: OrderDetailField[] = [
    { key: "orderNo", label: "订单编号", value: meta.orderNo },
    { key: "createdBy", label: "建档操作人", value: meta.createdBy },
    { key: "registeredAt", label: "登记时间", value: meta.registeredAt, className: "inventory-detail__datetime" },
    { key: "recoveryPlatform", label: "回收平台", value: meta.recoveryPlatform },
    { key: "consignmentSummary", label: "寄售平台 / 寄售时间", value: meta.consignmentSummary, className: "inventory-detail__datetime inventory-detail__multiline" },
    { key: "removedAt", label: "下架时间", value: meta.removedAt, className: "inventory-detail__datetime" },
    { key: "soldAt", label: "出售时间", value: meta.soldAt, className: "inventory-detail__datetime" },
    { key: "salePlatform", label: "售出平台", value: meta.salePlatform },
  ];
  const supplementalFields: OrderDetailField[] = [
    { key: "password", label: "账号密码", value: meta.password === "-" ? meta.password : <Typography.Text copyable>{meta.password}</Typography.Text> },
    { key: "channelRegion", label: "渠道 / 区服", value: meta.channelRegion },
    { key: "boundPhone", label: "绑定手机号", value: meta.boundPhone },
    { key: "secondary", label: "有无二次", value: meta.secondary },
    ...(meta.showProfileFields ? [
      { key: "description", label: "账号描述", value: meta.accountDescription },
      {
        key: "images",
        label: "账号图片",
        value: meta.accountImages.length ? <Image.PreviewGroup><Space wrap>{meta.accountImages.slice(0, 9).map((src, index) => <Image key={`${src}-${index}`} src={src} alt={`账号图片 ${index + 1}`} width={64} height={64} preview />)}</Space></Image.PreviewGroup> : "-",
      },
    ] : []),
    { key: "note", label: "备注", value: meta.note },
  ];
  const extraFieldsBySection = (section: string): OrderDetailField[] => meta.orderExtras
    .filter((field) => field.section === section)
    .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value }));
  const orderSupplementFields: OrderDetailField[] = [
    ...(meta.orderNotes !== "-" ? [{ key: "orderNotes", label: "订单备注", value: meta.orderNotes, className: "inventory-detail__multiline" }] : []),
    ...meta.orderExtras
      .filter((field) => field.section === "EXTRA")
      .map((field) => ({ key: `order-extra-${field.key}`, label: field.label, value: field.value })),
  ];
  const participantFields = [
    ...extraFieldsBySection("PARTICIPANT"),
    ...(meta.orderParties !== "-" ? [{ key: "orderParties", label: "参与方", value: meta.orderParties, className: "inventory-detail__multiline" }] : []),
  ];

  return (
    <div className="inventory-detail__section inventory-detail__section--profile">
      {editing ? <InventorySectionHeading title="游戏账号信息" /> : null}
      <div className="inventory-detail__meta">
        <div className="inventory-detail__meta-group">
          <div className="inventory-detail__meta-group-title">游戏账号信息</div>
          {editing ? (
            <>
              <div className="inventory-detail__edit-grid">
                {basicEditable.map((field) => {
                  const prop = field.key === "gameAccount" ? "game_account" : field.key === "gameType" ? "game_type" : "platform";
                  return (
                    <label key={field.key}>
                      <span>{field.label}</span>
                      <Input
                        aria-label={EDITABLE_BASIC_LABEL[field.key]}
                        value={account ? String(account[prop] ?? "") : ""}
                        onChange={(event) => { if (account) onEdit?.({ ...account, [prop]: event.target.value }); }}
                      />
                    </label>
                  );
                })}
              </div>
              <Descriptions className="inventory-detail__meta-table" size="small" bordered column={4}>
                {basicReadOnly.map((field) => <Descriptions.Item key={field.key} className={field.className} label={field.label}>{field.value}</Descriptions.Item>)}
              </Descriptions>
            </>
          ) : (
            <Descriptions className="inventory-detail__meta-table" size="small" bordered column={4}>
              {basicFields.map((field) => <Descriptions.Item key={field.key} className={field.className} label={field.label}>{field.value}</Descriptions.Item>)}
            </Descriptions>
          )}
        </div>
        <div className="inventory-detail__meta-group">
          <div className="inventory-detail__meta-group-title">登记与流转信息</div>
          <Descriptions className="inventory-detail__meta-table" size="small" bordered column={4}>
            {registrationFields.map((field) => <Descriptions.Item key={field.key} className={field.className} label={field.label}>{field.value}</Descriptions.Item>)}
          </Descriptions>
        </div>
        {orderSupplementFields.length ? <div className="inventory-detail__meta-group">
          <div className="inventory-detail__meta-group-title">其他补充信息</div>
          <Descriptions className="inventory-detail__meta-table inventory-detail__order-supplement" size="small" bordered column={1}>
            {orderSupplementFields.map((field) => <Descriptions.Item key={field.key} className={field.className} label={field.label}>{field.value}</Descriptions.Item>)}
          </Descriptions>
        </div> : null}
        <InventoryExtraFieldsGroup section="ACCOUNT_PRODUCT" fields={extraFieldsBySection("ACCOUNT_PRODUCT")} />
        <InventoryExtraFieldsGroup section="PARTICIPANT" fields={participantFields} />
        {!editing ? <div className="inventory-detail__meta-group">
          <div className="inventory-detail__meta-group-title">账号补充资料</div>
          <Descriptions className="inventory-detail__meta-table inventory-detail__long-meta" size="small" bordered column={4}>
            {supplementalFields.map((field) => {
              const fullRow = ["description", "images", "note"].includes(field.key);
              return <Descriptions.Item key={field.key} label={field.label} span={fullRow ? 4 : 1}>{field.value}</Descriptions.Item>;
            })}
          </Descriptions>
        </div> : null}
        {editing ? <OrderDetailEditFields editing={account as Account} onEdit={onEdit} /> : null}
      </div>
    </div>
  );
}
