import { CopyOutlined } from "@ant-design/icons";
import { DatePicker, Descriptions, Input, InputNumber, Switch, Tooltip } from "antd";
import dayjs from "dayjs";
import { useMemo } from "react";
import type { AccountExecutionDetail } from "../../../shared/api/types/account-execution";
import type { Account } from "../../../shared/api/types/accounts";
import type { OrderFormField } from "../../../shared/api/types/forms";
import type { OrderDraft } from "./editing/editor-types";
import {
  OrderSectionHeading,
  type OrderEmployeeOption,
  type OrderDetailMeta,
} from "./OrderDetail.shared";
import { OrderDetailImageGallery } from "./OrderDetailImageGallery";
import {
  buildFormExtraDisplay,
  fieldLabel,
  formatExtraDisplayValue,
  resolveOptionItems,
  isFieldActive,
  useOrderFormConfig,
  useOrderFormSectionLabels,
  FieldConfigStatus,
} from "../../../shared/forms/ConfigurableField";
import { appMessage } from "../../../shared/ui/appFeedback";
import { Select } from "../../../shared/ui";
import { indexEmployeeNames } from "../employee-names";

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
  account: Account;
};

type AccountProfileFieldDefinition = Omit<AccountProfileField, "value"> & {
  getValue: (source: AccountProfileValueSource) => string;
};

function fallbackValue(value: string | null | undefined, fallback = "-") {
  return value || fallback;
}

function channelRegionValue({ account }: AccountProfileValueSource) {
  return account.channel_region || "-";
}

const COPYABLE_PROFILE_KEYS = new Set<AccountProfileKey>(["gameAccount", "campAccount", "password"]);

const BUSINESS_OPERATOR_LABELS: Record<string, string> = {
  HS: "回收操作人",
  TH: "提号操作人",
  DG: "代挂操作人",
};

function CopyableProfileValue({ label, value }: { label: string; value: string }) {
  const canCopy = value !== "-" && value.trim().length > 0;

  const copy = async () => {
    if (!canCopy || !navigator.clipboard?.writeText) {
      appMessage.error("当前环境不支持复制");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      appMessage.success(`${label}已复制`);
    } catch {
      appMessage.error(`复制${label}失败`);
    }
  };

  return (
    <span className="order-detail__copy-value">
      <span>{value}</span>
      {canCopy ? (
        <Tooltip title={`复制${label}`}>
          <button
            type="button"
            className="order-detail__copy-button"
            aria-label={`复制${label}`}
            onClick={() => void copy()}
          >
            <CopyOutlined />
          </button>
        </Tooltip>
      ) : null}
    </span>
  );
}

const ACCOUNT_PROFILE_FIELD_DEFINITIONS: AccountProfileFieldDefinition[] = [
  { key: "gameType", cfgKey: "game_type", fallback: "游戏 / 产品类型", getValue: ({ account }) => fallbackValue(account.game_type) },
  { key: "gameAccount", cfgKey: "game_account", fallback: "游戏账号 / 产品", getValue: ({ account }) => fallbackValue(account.game_account) },
  { key: "campAccount", cfgKey: "camp_account", fallback: "营地账号", getValue: ({ account }) => fallbackValue(account.camp_account) },
  {
    key: "password",
    cfgKey: "game_password",
    fallback: "账号密码",
    getValue: ({ account }) => fallbackValue(account.game_password),
  },
  { key: "channelRegion", cfgKey: "channel_region", fallback: "渠道 / 区服", getValue: channelRegionValue },
  {
    key: "secondary",
    cfgKey: "has_secondary",
    fallback: "有无二次",
    getValue: ({ account }) => account.has_secondary == null ? "-" : account.has_secondary ? "有" : "无",
  },
  { key: "walletRealname", cfgKey: "wallet_realname", fallback: "钱包实名", getValue: ({ account }) => fallbackValue(account.wallet_realname) },
  { key: "note", cfgKey: "game_account_note", fallback: "账号备注", getValue: ({ account }) => fallbackValue(account.note) },
];

function buildAccountProfileFields(source: AccountProfileValueSource): AccountProfileField[] {
  return ACCOUNT_PROFILE_FIELD_DEFINITIONS.map(({ getValue, ...definition }) => ({
    ...definition,
    value: getValue(source),
  }));
}

function accountImages(account: Account) {
  return {
    secondary: account.secondary_images ?? [],
    walletRealname: account.wallet_realname_images ?? [],
  };
}

/** 板块1：游戏账号信息。基础字段、图片和账号自定义字段统一在此收口。 */
export function OrderDetailProfileSection({
  meta,
  account,
  detail,
  editing = false,
  onProfileChange,
  orderDrafts,
  employees = [],
}: {
  meta: OrderDetailMeta;
  account?: Account | null;
  detail?: AccountExecutionDetail | null;
  editing?: boolean;
  onProfileChange?: (changes: Partial<Account>) => void;
  orderDrafts?: Record<number, OrderDraft>;
  employees?: OrderEmployeeOption[];
}) {
  const creationOrder = useMemo(
    () => detail?.orders.find((order) => order.order_no === meta.sourceOrderNo),
    [detail, meta.sourceOrderNo],
  );
  const creationOrderType = creationOrder?.order_type ?? undefined;
  const businessOperatorLabel = creationOrderType ? BUSINESS_OPERATOR_LABELS[creationOrderType] : undefined;
  const draftOperatorIds = creationOrder ? orderDrafts?.[creationOrder.order_id]?.form_extra?.business_responsible_ids : undefined;
  const employeeNames = useMemo(() => indexEmployeeNames(employees), [employees]);
  const businessOperator = Array.isArray(draftOperatorIds)
    ? draftOperatorIds.map((id: unknown) => (typeof id === "number" ? employeeNames.get(id) : undefined) ?? "未知员工").join("、") || "-"
    : creationOrder?.operator || "-";
  const { config: creationConfig, ready: configReady, error: configError, retry: retryConfig } = useOrderFormConfig(creationOrderType);
  const { labels: sectionLabels } = useOrderFormSectionLabels(creationOrderType);
  // 编辑态必须以本地草稿 account 为唯一受控源；详情快照只用于只读展示。
  // 否则每次输入都会被 detail.account 的旧值覆盖，表现为输入框无法编辑。
  const profileAccount = account;
  const profileSource = useMemo(() => profileAccount ? ({ account: profileAccount }) : null, [profileAccount]);
  const accountProfileFields = useMemo(
    () => profileSource ? buildAccountProfileFields(profileSource) : [],
    [profileSource],
  );
  const visibleAccountProfileFields = useMemo(
    () => accountProfileFields.filter((field) => isFieldActive(creationConfig, field.cfgKey)),
    [accountProfileFields, creationConfig],
  );
  const images = useMemo(() => profileAccount ? accountImages(profileAccount) : { secondary: [], walletRealname: [] }, [profileAccount]);

  const accountExtraItems = useMemo(() => {
    const extraValues = profileAccount?.extra_values ?? {};
    const existing = buildFormExtraDisplay(extraValues, Object.values(creationConfig)).filter(
      (item) => (creationConfig[item.key]?.section ?? "EXTRA") === "ACCOUNT_PRODUCT",
    );
    const existingByKey = new Map(existing.map((item) => [item.key, item]));
    const configured = Object.values(creationConfig)
      .filter((field) => field.is_custom && field.is_active && field.section === "ACCOUNT_PRODUCT")
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((field) => existingByKey.get(field.field_key)
        ?? { key: field.field_key, label: field.label, value: "", status: "active" as const });
    const configuredKeys = new Set(configured.map((item) => item.key));
    return [...configured, ...existing.filter((item) => !configuredKeys.has(item.key))];
  }, [creationConfig, profileAccount]);

  return (
    <div className="order-detail__section order-detail__section--profile">
      <OrderSectionHeading title={sectionLabels["ACCOUNT_PRODUCT"] ?? "游戏账号信息"} />
      {!editing ? <FieldConfigStatus scope="PROFILE" ready={configReady} error={configError} retry={retryConfig} /> : null}
      <div className="order-detail__meta">
        <div className="order-detail__meta-group">
          <div className="order-detail__meta-group-title">账号资料</div>
          <Descriptions className="order-detail__meta-table" size="small" bordered column={3}>
            {visibleAccountProfileFields.map((field) => (
                <Descriptions.Item key={field.key} label={fieldLabel(creationConfig, field.cfgKey, field.fallback)}>
                  {editing ? (
                    <EditableProfileField field={field} account={profileAccount} onChange={onProfileChange} />
                  ) : COPYABLE_PROFILE_KEYS.has(field.key) ? (
                    <CopyableProfileValue label={field.fallback} value={field.value} />
                  ) : field.value}
                </Descriptions.Item>
              ))}
            {businessOperatorLabel ? (
              <Descriptions.Item label={fieldLabel(creationConfig, "business_responsible_ids", businessOperatorLabel)}>
                {businessOperator}
              </Descriptions.Item>
            ) : null}
          </Descriptions>
          <Descriptions className="order-detail__meta-table" size="small" bordered column={2}>
            <Descriptions.Item label="二次图片（选填）">
              <OrderDetailImageGallery images={images.secondary} field="secondary_images" altPrefix="二次图片" ownerKey={account?.id} editing={editing} onChange={(next) => onProfileChange?.({ secondary_images: next })} />
            </Descriptions.Item>
            <Descriptions.Item label="钱包实名图片（选填）">
              <OrderDetailImageGallery images={images.walletRealname} field="wallet_realname_images" altPrefix="钱包实名图片" ownerKey={account?.id} editing={editing} onChange={(next) => onProfileChange?.({ wallet_realname_images: next })} />
            </Descriptions.Item>
          </Descriptions>
        </div>
        {accountExtraItems.length ? (
          <div className="order-detail__meta-group">
            <div className="order-detail__meta-group-title">{sectionLabels["ACCOUNT_PRODUCT"] ?? "账号 / 产品补充信息"}</div>
            <Descriptions className="order-detail__meta-table" size="small" bordered column={3}>
              {accountExtraItems.map((item) => (
                <Descriptions.Item key={item.key} label={`${item.label}${item.status === "deleted" ? "（已删除）" : item.status === "inactive" ? "（已停用）" : ""}`}>
                  {editing ? (
                    <EditableAccountExtra
                      label={item.label}
                      definition={creationConfig[item.key]}
                      value={profileAccount?.extra_values?.[item.key]}
                      onChange={(value) => onProfileChange?.({
                        extra_values: {
                          ...(profileAccount?.extra_values ?? {}),
                          [item.key]: value,
                        },
                      })}
                    />
                  ) : formatExtraDisplayValue(item.value) || "-"}
                </Descriptions.Item>
              ))}
            </Descriptions>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EditableAccountExtra({ label, definition, value, onChange }: {
  label: string;
  definition?: OrderFormField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const ariaLabel = `编辑${label}`;
  switch (definition?.field_type) {
    case "NUMBER":
      return <InputNumber aria-label={ariaLabel} value={typeof value === "number" ? value : null} onChange={onChange} />;
    case "BOOLEAN":
      return <Switch aria-label={ariaLabel} checked={value === true} onChange={onChange} />;
    case "DATE":
      return <DatePicker aria-label={ariaLabel} value={typeof value === "string" && dayjs(value).isValid() ? dayjs(value) : null}
        onChange={(date) => onChange(date ? date.format("YYYY-MM-DD") : null)} />;
    case "SELECT":
      return <Select aria-label={ariaLabel} value={typeof value === "string" ? value : undefined}
        options={resolveOptionItems(definition.options)} allowClear onChange={onChange} />;
    case "MULTI_SELECT":
      return <Select aria-label={ariaLabel} mode="multiple" value={Array.isArray(value) ? value : []}
        options={resolveOptionItems(definition.options)} allowClear onChange={onChange} />;
    default:
      return <Input aria-label={ariaLabel} value={formatExtraDisplayValue(value)} onChange={(event) => onChange(event.target.value)} />;
  }
}

function EditableProfileField({
  field,
  account,
  onChange,
}: {
  field: AccountProfileField;
  account?: Account | null;
  onChange?: (changes: Partial<Account>) => void;
}) {
  if (field.key === "secondary") {
    return (
      <Select
        aria-label="编辑有无二次"
        value={account?.has_secondary == null ? undefined : account.has_secondary ? "true" : "false"}
        placeholder="请选择"
        options={[{ value: "true", label: "有" }, { value: "false", label: "无" }]}
        onChange={(value: string) => onChange?.({ has_secondary: value === "true" })}
      />
    );
  }
  if (field.key === "walletRealname") {
    return (
      <Select
        aria-label="编辑钱包实名"
        allowClear
        value={account?.wallet_realname ?? undefined}
        placeholder="请选择"
        options={[{ value: "未注销", label: "未注销" }, { value: "已注销", label: "已注销" }]}
        onChange={(value: string | undefined) => onChange?.({ wallet_realname: value ?? null })}
      />
    );
  }
  if (field.key === "channelRegion") {
    return (
      <Input aria-label="编辑渠道区服" value={account?.channel_region ?? ""} placeholder="渠道 / 区服" onChange={(event) => onChange?.({ channel_region: event.target.value })} />
    );
  }
  const value = field.key === "gameType"
      ? account?.game_type ?? ""
      : field.key === "gameAccount"
        ? account?.game_account ?? ""
        : field.key === "campAccount"
          ? account?.camp_account ?? ""
          : field.key === "password"
            ? account?.game_password ?? ""
            : account?.note ?? "";
  const key = field.key === "gameType"
      ? "game_type"
      : field.key === "gameAccount"
        ? "game_account"
        : field.key === "campAccount"
          ? "camp_account"
          : field.key === "password"
            ? "game_password"
            : "note";
  return <Input aria-label={`编辑${field.fallback}`} value={value} onChange={(event) => onChange?.({ [key]: event.target.value })} />;
}
