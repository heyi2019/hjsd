import { Descriptions } from "antd";
import { useMemo } from "react";
import type { AccountExecutionDetail } from "../shared/api/types/account-execution";
import type { Account } from "../shared/api/types/accounts";
import {
  InventorySectionHeading,
  findCreationOrder,
  type OrderDetailMeta,
} from "./OrderDetail.shared";
import { OrderDetailImageGallery } from "./OrderDetailImageGallery";
import {
  buildFormExtraDisplay,
  fieldLabel,
  formatExtraDisplayValue,
  isFieldActive,
  useOrderFormConfig,
  useOrderFormSectionLabels,
} from "../orders/ConfigurableField";

type AccountProfileKey =
  | "gameType"
  | "gameAccount"
  | "campAccount"
  | "password"
  | "channelRegion"
  | "secondary"
  | "walletRealname"
  | "note";

type AccountProfileField = {
  key: AccountProfileKey;
  cfgKey: string;
  fallback: string;
  value: string;
};

type AccountProfileValueSource = {
  meta: OrderDetailMeta;
  account?: Account | null;
};

type AccountProfileFieldDefinition = Omit<AccountProfileField, "value"> & {
  getValue: (source: AccountProfileValueSource) => string;
};

function fallbackValue(value: string | null | undefined, fallback = "-") {
  return value || fallback;
}

function channelRegionValue({ meta, account }: AccountProfileValueSource) {
  return [account?.platform, account?.channel_region].filter(Boolean).join(" / ") || fallbackValue(meta.channelRegion);
}

const ACCOUNT_PROFILE_FIELD_DEFINITIONS: AccountProfileFieldDefinition[] = [
  { key: "gameType", cfgKey: "game_type", fallback: "游戏 / 产品类型", getValue: ({ meta, account }) => fallbackValue(account?.game_type, meta.gameType ?? undefined) },
  { key: "gameAccount", cfgKey: "game_account", fallback: "游戏账号 / 产品", getValue: ({ meta, account }) => fallbackValue(account?.game_account, meta.gameAccount ?? undefined) },
  { key: "campAccount", cfgKey: "camp_account", fallback: "营地账号", getValue: ({ meta, account }) => fallbackValue(account?.camp_account, meta.campAccount ?? undefined) },
  {
    key: "password",
    cfgKey: "game_password",
    fallback: "账号密码",
    getValue: ({ meta, account }) => (fallbackValue(account?.game_password, meta.password) === "-" ? "-" : "已隐藏"),
  },
  { key: "channelRegion", cfgKey: "channel_region", fallback: "渠道 / 区服", getValue: channelRegionValue },
  {
    key: "secondary",
    cfgKey: "has_secondary",
    fallback: "有无二次",
    getValue: ({ meta, account }) => account?.has_secondary == null ? fallbackValue(meta.secondary) : account.has_secondary ? "有" : "无",
  },
  { key: "walletRealname", cfgKey: "wallet_realname", fallback: "钱包实名", getValue: ({ meta, account }) => fallbackValue(account?.wallet_realname, meta.walletRealname) },
  { key: "note", cfgKey: "game_account_note", fallback: "账号备注", getValue: ({ meta, account }) => fallbackValue(account?.note, meta.note) },
];

function buildAccountProfileFields(source: AccountProfileValueSource): AccountProfileField[] {
  return ACCOUNT_PROFILE_FIELD_DEFINITIONS.map(({ getValue, ...definition }) => ({
    ...definition,
    value: getValue(source),
  }));
}

function accountImages(account: Account | null | undefined, meta: OrderDetailMeta) {
  return {
    secondary: account?.secondary_images ?? meta.secondaryImages,
    walletRealname: account?.wallet_realname_images ?? meta.walletRealnameImages,
  };
}

/** 板块1：游戏账号信息。基础字段、图片和账号自定义字段统一在此收口。 */
export function OrderDetailProfileSection({
  meta,
  account,
  detail,
}: {
  meta: OrderDetailMeta;
  account?: Account | null;
  detail?: AccountExecutionDetail | null;
}) {
  const creationOrder = useMemo(() => findCreationOrder(detail, meta.sourceOrderNo), [detail, meta.sourceOrderNo]);
  const creationOrderType = creationOrder?.order_type ?? undefined;
  const { config: creationConfig } = useOrderFormConfig(creationOrderType);
  const { labels: sectionLabels } = useOrderFormSectionLabels(creationOrderType);
  const profileAccount = detail?.account ?? account;
  const profileSource = useMemo(() => ({ meta, account: profileAccount }), [meta, profileAccount]);
  const accountProfileFields = useMemo(() => buildAccountProfileFields(profileSource), [profileSource]);
  const images = useMemo(() => accountImages(profileAccount, meta), [profileAccount, meta]);

  const accountExtraItems = useMemo(() => {
    const extraValues = {
      ...(profileAccount?.extra_values ?? {}),
      ...(creationOrder?.extra_values ?? {}),
    };
    return buildFormExtraDisplay(extraValues, Object.values(creationConfig)).filter(
      (item) => (creationConfig[item.key]?.section ?? "EXTRA") === "ACCOUNT_PRODUCT",
    );
  }, [creationOrder, creationConfig, profileAccount]);

  return (
    <div className="inventory-detail__section inventory-detail__section--profile">
      <InventorySectionHeading title={sectionLabels["ACCOUNT_PRODUCT"] ?? "游戏账号信息"} />
      <div className="inventory-detail__meta">
        <div className="inventory-detail__meta-group">
          <div className="inventory-detail__meta-group-title">账号资料</div>
          <Descriptions className="inventory-detail__meta-table" size="small" bordered column={3}>
            {accountProfileFields
              .filter((field) => isFieldActive(creationConfig, field.cfgKey))
              .map((field) => (
                <Descriptions.Item key={field.key} label={fieldLabel(creationConfig, field.cfgKey, field.fallback)}>
                  {field.value}
                </Descriptions.Item>
              ))}
          </Descriptions>
          <Descriptions className="inventory-detail__meta-table" size="small" bordered column={2}>
            <Descriptions.Item label="二次图片（选填）">
              <OrderDetailImageGallery images={images.secondary} altPrefix="二次图片" />
            </Descriptions.Item>
            <Descriptions.Item label="钱包实名图片（选填）">
              <OrderDetailImageGallery images={images.walletRealname} altPrefix="钱包实名图片" />
            </Descriptions.Item>
          </Descriptions>
        </div>
        {accountExtraItems.length ? (
          <div className="inventory-detail__meta-group">
            <div className="inventory-detail__meta-group-title">{sectionLabels["ACCOUNT_PRODUCT"] ?? "账号 / 产品补充信息"}</div>
            <Descriptions className="inventory-detail__meta-table" size="small" bordered column={3}>
              {accountExtraItems.map((item) => (
                <Descriptions.Item key={item.key} label={`${item.label}${item.status === "deleted" ? "（已删除）" : item.status === "inactive" ? "（已停用）" : ""}`}>
                  {formatExtraDisplayValue(item.value) || "-"}
                </Descriptions.Item>
              ))}
            </Descriptions>
          </div>
        ) : null}
      </div>
    </div>
  );
}
