import { Descriptions, Input } from "antd";
import { useMemo } from "react";
import type { Account, AccountExecutionDetail } from "../../shared/api/catalog";
import { Select } from "../../shared/ui";
import {
  InventorySectionHeading,
  findCreationOrder,
  type OrderDetailField,
  type OrderDetailMeta,
  type InventoryOrderDraft,
} from "./OrderDetail.shared";
import {
  buildFormExtraDisplay,
  fieldLabel,
  formatExtraDisplayValue,
  isFieldActive,
  useOrderFormConfig,
  useOrderFormSectionLabels,
} from "../ConfigurableField";

/** 账号字段 key（与建单 RecoveryAccountSection 对齐）→ 配置 key / 兜底标签。
 *  走建单：显隐与标签由 OrderFormField 配置驱动；无配置时回落兜底标签且默认显示。 */
const ACCOUNT_FIELD_MAP: Record<string, { cfgKey: string; fallback: string }> = {
  gameType: { cfgKey: "game_type", fallback: "游戏 / 产品类型" },
  gameAccount: { cfgKey: "game_account", fallback: "游戏账号 / 产品" },
  campAccount: { cfgKey: "camp_account", fallback: "营地账号" },
  password: { cfgKey: "game_password", fallback: "账号密码" },
  channelRegion: { cfgKey: "channel_region", fallback: "渠道 / 区服" },
  secondary: { cfgKey: "has_secondary", fallback: "有无二次" },
  walletRealname: { cfgKey: "wallet_realname", fallback: "钱包实名" },
  note: { cfgKey: "game_account_note", fallback: "账号备注" },
};

/** 板块1：游戏账号信息。账号资料 + ACCOUNT_PRODUCT 自定义字段走建单配置驱动；
 *  主订单信息（业务/订单级，含平台/成本/业务/业务类型/增值服务）保持现状，不接字典/配置。 */
export function OrderDetailProfileSection({
  meta,
  editing,
  account,
  onEdit,
  detail,
  timeDrafts,
  onTimeEdit,
  orderDrafts,
  onOrderEdit,
}: {
  meta: OrderDetailMeta;
  editing?: boolean;
  account?: Account | null;
  onEdit?: (account: Account) => void;
  detail?: AccountExecutionDetail | null;
  timeDrafts?: { registered_at?: string | null; sold_at?: string | null };
  onTimeEdit?: (key: "registered_at" | "sold_at", value: string | null) => void;
  orderDrafts?: Record<number, InventoryOrderDraft>;
  onOrderEdit?: (orderId: number, changes: InventoryOrderDraft) => void;
}) {
  const creationOrder = useMemo(() => findCreationOrder(detail, meta.sourceOrderNo), [detail, meta.sourceOrderNo]);
  const creationOrderType = creationOrder?.order_type ?? undefined;
  const { config: creationConfig } = useOrderFormConfig(creationOrderType);
  const { labels: sectionLabels } = useOrderFormSectionLabels(creationOrderType);
  const accountTitle = sectionLabels["ACCOUNT_PRODUCT"] ?? "游戏账号信息";

  const accountProfileFields: OrderDetailField[] = [
    { key: "gameType", label: ACCOUNT_FIELD_MAP.gameType.fallback, value: meta.gameType || "-" },
    { key: "gameAccount", label: ACCOUNT_FIELD_MAP.gameAccount.fallback, value: meta.gameAccount || "-" },
    { key: "campAccount", label: ACCOUNT_FIELD_MAP.campAccount.fallback, value: meta.campAccount || "-" },
    {
      key: "password",
      label: ACCOUNT_FIELD_MAP.password.fallback,
      value: meta.password === "-" ? meta.password : "已隐藏",
    },
    { key: "channelRegion", label: ACCOUNT_FIELD_MAP.channelRegion.fallback, value: meta.channelRegion },
    { key: "secondary", label: ACCOUNT_FIELD_MAP.secondary.fallback, value: meta.secondary },
    { key: "walletRealname", label: ACCOUNT_FIELD_MAP.walletRealname.fallback, value: meta.walletRealname },
    { key: "note", label: ACCOUNT_FIELD_MAP.note.fallback, value: meta.note },
  ];

  // ACCOUNT_PRODUCT 自定义字段：走建单来源单 / 账号的 extra_values，按来源单配置驱动（带 停用/删除 状态）。
  const accountExtraItems = useMemo(() => {
    const source = creationOrder?.extra_values ?? account?.extra_values ?? null;
    if (!source) return [];
    return buildFormExtraDisplay(source, Object.values(creationConfig)).filter(
      (item) => (creationConfig[item.key]?.section ?? "EXTRA") === "ACCOUNT_PRODUCT",
    );
  }, [creationOrder, account, creationConfig]);

  if (editing) {
    const update = <K extends keyof Account>(key: K, value: Account[K]) => {
      if (account) onEdit?.({ ...account, [key]: value });
    };
    const inputFor = (key: string) => {
      switch (key) {
        case "gameType": return <Input aria-label="编辑游戏/产品类型" value={account?.game_type ?? ""} onChange={(event) => update("game_type", event.target.value)} />;
        case "gameAccount": return <Input aria-label="编辑游戏账号/产品" value={account?.game_account ?? ""} onChange={(event) => update("game_account", event.target.value)} />;
        case "campAccount": return <Input aria-label="编辑营地账号" value={account?.camp_account ?? ""} onChange={(event) => update("camp_account", event.target.value)} />;
        case "password": return <Input.Password aria-label="编辑账号密码" value={account?.game_password ?? ""} onChange={(event) => update("game_password", event.target.value)} />;
        case "channelRegion": return <Input aria-label="编辑渠道 / 区服" value={account?.channel_region ?? ""} onChange={(event) => update("channel_region", event.target.value)} />;
        case "secondary": return <Select aria-label="编辑有无二次" allowClear value={account?.has_secondary == null ? undefined : account.has_secondary ? "有" : "无"} options={[{ value: "有", label: "有二次" }, { value: "无", label: "无二次" }]} onChange={(value) => update("has_secondary", value == null ? null : value === "有")} />;
        case "walletRealname": return <Input aria-label="编辑钱包实名" value={account?.wallet_realname ?? ""} onChange={(event) => update("wallet_realname", event.target.value)} />;
        case "note": return <Input.TextArea aria-label="编辑备注" rows={2} value={account?.note ?? ""} onChange={(event) => update("note", event.target.value)} />;
        default: return null;
      }
    };
    return (
      <div className="inventory-detail__section inventory-detail__section--profile">
        <InventorySectionHeading title={accountTitle} />
        <div className="inventory-detail__meta">
          <div className="inventory-detail__meta-group">
            <div className="inventory-detail__meta-group-title">账号资料</div>
            <Descriptions className="inventory-detail__meta-table" size="small" bordered column={6}>
              {accountProfileFields.map((field) => {
                const map = ACCOUNT_FIELD_MAP[field.key];
                if (!map || !isFieldActive(creationConfig, map.cfgKey)) return null;
                return <Descriptions.Item key={field.key} label={fieldLabel(creationConfig, map.cfgKey, map.fallback)}>{inputFor(field.key)}</Descriptions.Item>;
              })}
              <Descriptions.Item label="绑定手机号"><Input aria-label="编辑绑定手机号" value={account?.bound_phone ?? ""} onChange={(event) => update("bound_phone", event.target.value)} /></Descriptions.Item>
              <Descriptions.Item label="平台"><Input aria-label="编辑平台" value={account?.platform ?? ""} onChange={(event) => update("platform", event.target.value)} /></Descriptions.Item>
              <Descriptions.Item label="账号描述" span={3}><Input.TextArea aria-label="编辑账号描述" rows={2} maxLength={2000} value={account?.account_description ?? ""} onChange={(event) => update("account_description", event.target.value)} /></Descriptions.Item>
              <Descriptions.Item label="登记时间"><Input type="datetime-local" aria-label="编辑登记时间" value={(timeDrafts?.registered_at ?? "").replace(" ", "T").slice(0, 16)} onChange={(event) => onTimeEdit?.("registered_at", event.target.value || null)} /></Descriptions.Item>
              <Descriptions.Item label="售出时间"><Input type="datetime-local" aria-label="编辑售出时间" value={(timeDrafts?.sold_at ?? "").replace(" ", "T").slice(0, 16)} onChange={(event) => onTimeEdit?.("sold_at", event.target.value || null)} /></Descriptions.Item>
            </Descriptions>
          </div>
          {creationOrder ? (
            <div className="inventory-detail__meta-group">
              <div className="inventory-detail__meta-group-title">订单信息</div>
              <Descriptions className="inventory-detail__meta-table" size="small" bordered column={6}>
                <Descriptions.Item label="订单日期"><Input type="date" aria-label="编辑订单日期" value={orderDrafts?.[creationOrder.order_id]?.trade_date ?? creationOrder.trade_date} onChange={(event) => onOrderEdit?.(creationOrder.order_id, { trade_date: event.target.value })} /></Descriptions.Item>
                <Descriptions.Item label="订单备注" span={5}><Input.TextArea aria-label="编辑订单备注" rows={2} value={orderDrafts?.[creationOrder.order_id]?.note ?? creationOrder.note ?? ""} onChange={(event) => onOrderEdit?.(creationOrder.order_id, { note: event.target.value })} /></Descriptions.Item>
              </Descriptions>
            </div>
          ) : null}
          {accountExtraItems.length ? (
            <div className="inventory-detail__meta-group">
              <div className="inventory-detail__meta-group-title">{sectionLabels["ACCOUNT_PRODUCT"] ?? "账号 / 产品补充信息"}</div>
              <Descriptions className="inventory-detail__meta-table" size="small" bordered column={6}>
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

  return (
    <div className="inventory-detail__section inventory-detail__section--profile">
      <InventorySectionHeading title={accountTitle} />
      <div className="inventory-detail__meta">
        <div className="inventory-detail__meta-group">
          <div className="inventory-detail__meta-group-title">账号资料</div>
          <Descriptions className="inventory-detail__meta-table" size="small" bordered column={6}>
            {accountProfileFields.map((field) => {
              const map = ACCOUNT_FIELD_MAP[field.key];
              if (!map || !isFieldActive(creationConfig, map.cfgKey)) return null;
              return (
                <Descriptions.Item key={field.key} className={field.className} label={fieldLabel(creationConfig, map.cfgKey, map.fallback)}>
                  {field.value}
                </Descriptions.Item>
              );
            })}
          </Descriptions>
        </div>
        {accountExtraItems.length ? (
          <div className="inventory-detail__meta-group">
            <div className="inventory-detail__meta-group-title">{sectionLabels["ACCOUNT_PRODUCT"] ?? "账号 / 产品补充信息"}</div>
            <Descriptions className="inventory-detail__meta-table" size="small" bordered column={6}>
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
