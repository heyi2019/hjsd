/** 库存：以账号为载体的状态与成本（ACC-01 / RPT-01-01）。回收、提号、代挂账号均从这里进入待售流程。 */
import { DownloadOutlined } from "@ant-design/icons";
import { Card, Descriptions, Image, Input, Modal, Select, Space, Spin, Typography, Upload, message } from "antd";
import type { UploadFile } from "antd/es/upload/interface";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState, type Key } from "react";
import { accountsApi, type Account, type AccountExecutionDetail } from "../shared/api/catalog";
import { errorMessage, normalizeError } from "../shared/api/client";
import {
  DataTable,
  ErrorBanner,
  MoneyText,
  PermissionButton,
  StatRow,
  StatusTag,
} from "../shared/ui";
import { InventorySaleModal } from "./InventorySaleModal";
import { InventoryConsignmentModal } from "./InventoryConsignmentModal";
import { InventoryRebateModal } from "./InventoryRebateModal";
import { executionActionLabel } from "../shared/lib/format";

const STATUS_OPTIONS = [
  { value: "IN_STOCK", label: "在库" },
  { value: "INSTALLMENT", label: "分期中" },
  { value: "FOR_SALE", label: "待售" },
  { value: "SOLD", label: "已售" },
  { value: "VOID", label: "下架" },
];

const BUSINESS_MODE_LABEL: Record<string, string> = {
  SELF: "自营",
  DISTRIBUTION: "分销",
};

const INVENTORY_TYPE_LABEL: Record<string, string> = {
  RECOVERY: "回收",
  PICKUP: "提号",
  CONSIGNMENT: "代挂",
};

const BUSINESS_OPTIONS = Object.entries(BUSINESS_MODE_LABEL).map(([value, label]) => ({ value, label }));
const INVENTORY_TYPE_OPTIONS = Object.entries(INVENTORY_TYPE_LABEL).map(([value, label]) => ({ value, label }));

const INVENTORY_EXPORT_HEADERS = [
  "订单号", "业务", "类型", "产品", "账号标识", "平台", "成本", "库存状态", "未售时长",
  "库存编号", "建档操作人", "登记时间", "出售时间", "下架时间", "寄售时间", "寄售平台",
  "账号密码", "渠道 / 区服", "绑定手机号", "有无二次", "账号描述", "账号图片", "备注", "执行明细", "资金明细",
  "支出笔数", "收入笔数", "总支出", "总收入",
];
const DAY_IN_MS = 24 * 60 * 60 * 1000;

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function inventoryStatusLabel(value: string): string {
  return STATUS_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function financeTypeLabel(eventType: string, direction: string): string {
  const labels: Record<string, string> = {
    BUY: "买号本金",
    COST: "账号成本",
    SELL: "售出回款",
    PAYMENT: "分期回款",
    CANCEL: "取消退款",
  };
  return labels[eventType] ?? (direction === "IN" ? "其他收入" : "其他支出");
}

function rebateTypeLabel(rebateType?: string | null, channel?: string | null): string {
  if (rebateType === "BUY") return "买号返点";
  if (rebateType === "SELL") return "卖号返点";
  if (channel === "买号返点") return "买号返点";
  if (channel === "卖号返点") return "卖号返点";
  return "其他返点";
}

function readImageData(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

const PROFILE_ACCOUNT_TYPES = new Set(["RECOVERY", "CONSIGNMENT"]);

function inventoryAge(row: Pick<Account, "status" | "buy_date">, now = new Date()): {
  days: number;
  color: "green" | "orange" | "red";
} | null {
  if (!["IN_STOCK", "INSTALLMENT", "FOR_SALE"].includes(row.status) || !row.buy_date) return null;
  const buyDate = new Date(`${row.buy_date}T00:00:00`);
  if (!Number.isFinite(buyDate.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.max(0, Math.floor((today.getTime() - buyDate.getTime()) / DAY_IN_MS));
  return {
    days,
    color: days <= 7 ? "green" : days <= 30 ? "orange" : "red",
  };
}

function exportDetailText(detail: AccountExecutionDetail | undefined): {
  registrationAt: string;
  soldAt: string;
  removedAt: string;
  consignmentAt: string;
  consignmentPlatforms: string;
  execution: string;
  finance: string;
  expenseCount: number;
  incomeCount: number;
  totalExpense: string;
  totalIncome: string;
} {
  const orders = detail?.orders ?? [];
  const financialFlows = orders.flatMap((order) => order.events.flatMap((event) => (
    event.cashflow ? [{ order, event, cashflow: event.cashflow }] : []
  )));
  const rebateItems = orders.flatMap((order) => (
    (order.rebates ?? []).map((rebate) => ({ order, rebate }))
  ));
  const expenseFlows = financialFlows.filter(({ cashflow }) => cashflow.direction === "OUT");
  const incomeFlows = financialFlows.filter(({ cashflow }) => cashflow.direction === "IN");
  const sourceOrder = orders[0];

  return {
    registrationAt: dateTimeMinute(sourceOrder?.created_at ?? sourceOrder?.trade_date),
    soldAt: eventDate(detail, "SELL"),
    removedAt: eventDate(detail, "CANCEL"),
    consignmentAt: platformListingDate(detail),
    consignmentPlatforms: consignmentPlatforms(detail),
    execution: orders.flatMap((order) => order.events.map((event) => [
      `${event.event_no} · ${executionActionLabel(event.event_type, order.order_type)}`,
      dateTimeMinute(event.occurred_at ?? event.occurred_on),
      event.amount,
      event.note || "-",
      event.operator || "-",
    ].join(" / "))).join("；"),
    finance: [
      ...financialFlows.map(({ order, event, cashflow }) => [
        financeTypeLabel(event.event_type, cashflow.direction),
        order.order_no,
        cashflow.flow_no,
        cashflow.direction === "OUT" ? "支出" : "收入",
        cashflow.amount,
        dateTimeMinute(cashflow.occurred_at ?? cashflow.occurred_on),
        cashflow.pool_name || "未分配资金池",
      ].join(" / ")),
      ...rebateItems.map(({ order, rebate }) => [
        rebateTypeLabel(rebate.rebate_type, rebate.channel),
        order.order_no,
        rebate.rebate_no,
        rebate.status,
        rebate.base_amount,
        `${rebate.rate}%`,
        dateTimeMinute(rebate.collected_at ?? rebate.collected_on),
      ].join(" / ")),
    ].join("；"),
    expenseCount: expenseFlows.length,
    incomeCount: incomeFlows.length,
    totalExpense: expenseFlows.reduce((sum, { cashflow }) => sum + Number(cashflow.amount), 0).toFixed(2),
    totalIncome: incomeFlows.reduce((sum, { cashflow }) => sum + Number(cashflow.amount), 0).toFixed(2),
  };
}

export function buildInventoryCsv(
  rows: Account[],
  details: Partial<Record<number, AccountExecutionDetail>> = {},
): string {
  const lines = [
    INVENTORY_EXPORT_HEADERS,
    ...rows.map((row) => {
      const detail = details[row.id];
      const detailText = exportDetailText(detail);
      const age = inventoryAge(row);
      return [
        row.source_order_no,
        row.business_mode ? BUSINESS_MODE_LABEL[row.business_mode] ?? row.business_mode : "",
        row.inventory_type ? INVENTORY_TYPE_LABEL[row.inventory_type] ?? row.inventory_type : "",
        row.game_type,
        row.game_account,
        row.platform,
        row.cost_amount,
        inventoryStatusLabel(row.status),
        age ? `${age.days}天` : "",
        row.inventory_no,
        row.created_by,
        detailText.registrationAt,
        detailText.soldAt,
        detailText.removedAt,
        detailText.consignmentAt,
        detailText.consignmentPlatforms,
        row.game_password,
        row.channel_region,
        row.bound_phone,
        row.has_secondary == null ? "" : row.has_secondary ? "有" : "无",
        row.account_description,
        (row.account_images ?? []).length ? `${(row.account_images ?? []).length}张` : "",
        row.note,
        detailText.execution,
        detailText.finance,
        detailText.expenseCount,
        detailText.incomeCount,
        detailText.totalExpense,
        detailText.totalIncome,
      ];
    }),
  ];
  return `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function downloadInventoryCsv(rows: Account[], details: Partial<Record<number, AccountExecutionDetail>>): void {
  const blob = new Blob([buildInventoryCsv(rows, details)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `库存中心_${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function dateTimeMinute(value: string | null | undefined): string {
  if (!value) return "-";
  const normalized = value.replace("T", " ");
  return normalized.length >= 16 ? normalized.slice(0, 16) : `${normalized.slice(0, 10)} 00:00`;
}

function eventDate(detail: AccountExecutionDetail | undefined, eventType: string): string {
  const event = detail?.orders.flatMap((order) => order.events)
    .find((item) => item.event_type === eventType);
  return dateTimeMinute(event?.occurred_at ?? event?.occurred_on);
}

function platformListingDate(detail: AccountExecutionDetail | undefined): string {
  const order = detail?.orders.find((item) => item.order_type === "DG");
  return dateTimeMinute(order?.created_at ?? order?.trade_date);
}

function consignmentPlatforms(detail: AccountExecutionDetail | undefined): string {
  const names = detail?.orders
    .filter((order) => order.order_type === "DG")
    .flatMap((order) => (order.counterparties ?? [])
      .filter((counterparty) => counterparty.role === "PLATFORM")
      .map((counterparty) => counterparty.display_name));
  return names?.length ? names.join("、") : "-";
}

function estimatedRebateAmount(baseAmount: string, rate: string): string {
  const amount = Number(baseAmount) * Number(rate) / 100;
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

type InventoryFinanceRow = {
  key: string;
  type: string;
  orderNo: string;
  financeNo: string;
  direction: "支出" | "收入" | "待结算";
  amount: string;
  rate: string;
  occurredAt: string;
  poolName: string;
  rebateStatus?: string;
  expectedRebate?: string;
};

type InventoryExecutionRow = {
  key: string;
  action: string;
  occurredAt: string;
  amount: string;
  operator: string;
  note: string;
};

export function InventoryPanel() {
  const [rows, setRows] = useState<Account[]>([]);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [businessMode, setBusinessMode] = useState<string | undefined>(undefined);
  const [inventoryType, setInventoryType] = useState<string | undefined>(undefined);
  const [keyword, setKeyword] = useState("");
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [saleTarget, setSaleTarget] = useState<Account | null>(null);
  const [consignmentTarget, setConsignmentTarget] = useState<Account | null>(null);
  const [rebateTarget, setRebateTarget] = useState<Account | null>(null);
  const [executionDetails, setExecutionDetails] = useState<Record<number, AccountExecutionDetail>>({});
  const [executionLoading, setExecutionLoading] = useState<Record<number, boolean>>({});
  const [expandedAccountIds, setExpandedAccountIds] = useState<Key[]>([]);
  const [exporting, setExporting] = useState(false);
  const [profileTarget, setProfileTarget] = useState<{ account: Account; mode: "description" | "images" | "all" } | null>(null);
  const [profileForm, setProfileForm] = useState({
    gameAccount: "",
    gameType: "",
    gamePassword: "",
    channelRegion: "",
    boundPhone: "",
    platform: "",
    hasSecondary: undefined as boolean | undefined,
    description: "",
    note: "",
  });
  const [profileImages, setProfileImages] = useState<UploadFile[]>([]);
  const [savingProfile, setSavingProfile] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await accountsApi.list(status ? { status } : undefined);
      setRows(list);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleRows = rows.filter((row) => {
    const matchesBusiness = !businessMode || row.business_mode === businessMode;
    const matchesType = !inventoryType || row.inventory_type === inventoryType;
    const text = [row.inventory_no, row.game_account, row.game_type, row.channel_region, row.platform]
      .filter(Boolean).join(" ").toLowerCase();
    const matchesKeyword = !keyword.trim() || text.includes(keyword.trim().toLowerCase());
    return matchesBusiness && matchesType && matchesKeyword;
  });
  const visibleOccupied = visibleRows.filter((row) => ["IN_STOCK", "INSTALLMENT"].includes(row.status));
  const totalCost = visibleOccupied.reduce((sum, row) => sum + Number(row.cost_amount), 0).toFixed(2);

  function openProfile(account: Account, mode: "description" | "images" | "all") {
    setProfileTarget({ account, mode });
    setProfileForm({
      gameAccount: account.game_account ?? "",
      gameType: account.game_type ?? "",
      gamePassword: account.game_password ?? "",
      channelRegion: account.channel_region ?? "",
      boundPhone: account.bound_phone ?? "",
      platform: account.platform ?? "",
      hasSecondary: account.has_secondary ?? undefined,
      description: account.account_description ?? "",
      note: account.note ?? "",
    });
    setProfileImages((account.account_images ?? []).slice(0, 9).map((url, index) => ({
      uid: `${account.id}-${index}`,
      name: `账号图片${index + 1}`,
      status: "done",
      url,
    })));
  }

  async function saveProfile() {
    if (!profileTarget) return;
    setSavingProfile(true);
    try {
      const payload = profileTarget.mode === "description"
        ? { account_description: profileForm.description }
        : profileTarget.mode === "images" ? {
            account_images: (await Promise.all(profileImages.slice(0, 9).map(async (file) => {
              if (file.url) return file.url;
              return file.originFileObj ? readImageData(file.originFileObj) : null;
            }))).filter((item): item is string => Boolean(item)),
          } : {
            game_account: profileForm.gameAccount,
            game_type: profileForm.gameType,
            game_password: profileForm.gamePassword,
            channel_region: profileForm.channelRegion,
            bound_phone: profileForm.boundPhone,
            platform: profileForm.platform,
            has_secondary: profileForm.hasSecondary,
            account_description: profileForm.description,
            account_images: (await Promise.all(profileImages.slice(0, 9).map(async (file) => {
              if (file.url) return file.url;
              return file.originFileObj ? readImageData(file.originFileObj) : null;
            }))).filter((item): item is string => Boolean(item)),
            note: profileForm.note,
          };
      const updated = await accountsApi.updateProfile(profileTarget.account.id, payload);
      setRows((current) => current.map((row) => row.id === updated.id ? { ...row, ...updated } : row));
      setExecutionDetails((current) => {
        const detail = current[updated.id];
        return detail ? { ...current, [updated.id]: { ...detail, account: { ...detail.account, ...updated } } } : current;
      });
      setProfileTarget(null);
      message.success("账号资料已保存");
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSavingProfile(false);
    }
  }

  const columns: ColumnsType<Account> = [
    { title: "订单号", dataIndex: "source_order_no", render: (v: string | null) => v || "-" },
    { title: "业务", dataIndex: "business_mode", render: (v: string | null) => v ? BUSINESS_MODE_LABEL[v] ?? v : "-" },
    { title: "类型", dataIndex: "inventory_type", render: (v: string | null) => v ? INVENTORY_TYPE_LABEL[v] ?? v : "-" },
    { title: "产品", dataIndex: "game_type", render: (v: string | null) => v || "-" },
    { title: "账号标识", dataIndex: "game_account" },
    { title: "平台", dataIndex: "platform" },
    {
      title: "未售时长",
      key: "inventoryAge",
      render: (_value, row) => {
        const age = inventoryAge(row);
        return age ? <StatusTag status={row.status} color={age.color} label={`${age.days}天`} /> : "-";
      },
    },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} label={v === "VOID" ? "下架" : undefined} /> },
    {
      title: "成本",
      dataIndex: "cost_amount",
      align: "right",
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: "操作",
      key: "actions",
      render: (_value, row) => (
        <Space size="small">
          <PermissionButton
            permission="order.create"
            type="link"
            size="small"
            aria-label="售出"
            disabled={!['IN_STOCK', 'FOR_SALE'].includes(row.status)}
            onClick={(event) => {
              event.stopPropagation();
              setSaleTarget(row);
            }}
          >
            售出
          </PermissionButton>
          <PermissionButton
            permission="order.create"
            type="link"
            size="small"
            aria-label="寄售"
            disabled={row.status === "SOLD"}
            onClick={(event) => {
              event.stopPropagation();
              setConsignmentTarget(row);
            }}
          >
            寄售
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            type="link"
            size="small"
            aria-label="下架"
            disabled={row.status === "SOLD"}
            onClick={(event) => {
              event.stopPropagation();
              message.info("下架请按来源订单执行下架流程");
            }}
          >
            下架
          </PermissionButton>
          <PermissionButton
            permission="order.event.post"
            type="link"
            size="small"
            aria-label="返点"
            onClick={(event) => {
              event.stopPropagation();
              setRebateTarget(row);
            }}
          >
            返点
          </PermissionButton>
          {PROFILE_ACCOUNT_TYPES.has(row.inventory_type ?? "") ? <>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              aria-label="编辑"
              onClick={(event) => {
                event.stopPropagation();
                openProfile(row, "all");
              }}
            >
              编辑
            </PermissionButton>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              aria-label="账号描述"
              disabled={row.status === "SOLD"}
              onClick={(event) => {
                event.stopPropagation();
                openProfile(row, "description");
              }}
            >
              账号描述
            </PermissionButton>
            <PermissionButton
              permission="order.create"
              type="link"
              size="small"
              aria-label="账号图片"
              disabled={row.status === "SOLD"}
              onClick={(event) => {
                event.stopPropagation();
                openProfile(row, "images");
              }}
            >
              账号图片
            </PermissionButton>
          </> : null}
        </Space>
      ),
    },
  ];

  const renderInventoryDetail = (row: Account) => {
    const detail = executionDetails[row.id];
    const sourceOrder = detail?.orders[0];
    if (executionLoading[row.id] && !detail) return <Spin size="small" />;
    const financialFlows = detail?.orders.flatMap((order) => order.events.flatMap((event) => (
      event.cashflow ? [{ order, event, cashflow: event.cashflow }] : []
    ))) ?? [];
    const rebateItems = detail?.orders.flatMap((order) => (
      (order.rebates ?? []).map((rebate) => ({ order, rebate }))
    )) ?? [];
    const expenseFlows = financialFlows.filter(({ cashflow }) => cashflow.direction === "OUT");
    const incomeFlows = financialFlows.filter(({ cashflow }) => cashflow.direction === "IN");
    const totalExpense = expenseFlows.reduce((sum, { cashflow }) => sum + Number(cashflow.amount), 0).toFixed(2);
    const totalIncome = incomeFlows.reduce((sum, { cashflow }) => sum + Number(cashflow.amount), 0).toFixed(2);
    const financeRows: InventoryFinanceRow[] = [
      ...financialFlows.map(({ order, event, cashflow }) => ({
        key: `flow-${cashflow.flow_no}`,
        type: financeTypeLabel(event.event_type, cashflow.direction),
        orderNo: order.order_no,
        financeNo: cashflow.flow_no,
        direction: cashflow.direction === "OUT" ? "支出" as const : "收入" as const,
        amount: cashflow.amount,
        rate: "-",
        occurredAt: dateTimeMinute(cashflow.occurred_at ?? cashflow.occurred_on),
        poolName: cashflow.pool_name || "未分配资金池",
      })),
      ...rebateItems.map(({ order, rebate }) => ({
        key: `rebate-${rebate.id}`,
        type: rebateTypeLabel(rebate.rebate_type, rebate.channel),
        orderNo: order.order_no,
        financeNo: rebate.rebate_no,
        direction: rebate.status === "SETTLED" ? "收入" as const : "待结算" as const,
        amount: rebate.base_amount,
        rate: `${rebate.rate}%`,
        occurredAt: dateTimeMinute(rebate.collected_at ?? rebate.collected_on),
        poolName: "-",
        rebateStatus: rebate.status,
        expectedRebate: estimatedRebateAmount(rebate.base_amount, rebate.rate),
      })),
    ];
    const financeColumns: ColumnsType<InventoryFinanceRow> = [
      { title: "类型", dataIndex: "type", key: "type" },
      { title: "订单号", dataIndex: "orderNo", key: "orderNo" },
      { title: "资金编号", dataIndex: "financeNo", key: "financeNo" },
      {
        title: "方向",
        dataIndex: "direction",
        key: "direction",
        render: (value: InventoryFinanceRow["direction"]) => (
          <Typography.Text type={value === "收入" ? "success" : value === "支出" ? "danger" : "secondary"}>
            {value}
          </Typography.Text>
        ),
      },
      {
        title: "金额",
        dataIndex: "amount",
        key: "amount",
        align: "right",
        render: (value: string, financeRow) => (
          <div className="inventory-finance-table__amount">
            <MoneyText value={value} />
            {financeRow.expectedRebate ? (
              <Typography.Text type="secondary">预计返点 {financeRow.expectedRebate}</Typography.Text>
            ) : null}
          </div>
        ),
      },
      { title: "比例", dataIndex: "rate", key: "rate", align: "right" },
      { title: "时间", dataIndex: "occurredAt", key: "occurredAt" },
      {
        title: "资金池 / 状态",
        key: "poolName",
        render: (_value, financeRow) => financeRow.rebateStatus
          ? <StatusTag status={financeRow.rebateStatus} />
          : financeRow.poolName,
      },
    ];
    const executionRows: InventoryExecutionRow[] = detail?.orders.flatMap((order) => (
      order.events.map((event) => ({
        key: `${order.order_id}-${event.id}`,
        action: `${event.event_no} · ${executionActionLabel(event.event_type, order.order_type)}`,
        occurredAt: dateTimeMinute(event.occurred_at ?? event.occurred_on),
        amount: event.amount,
        operator: event.operator || "-",
        note: event.note || "-",
      }))
    )) ?? [];
    const executionColumns: ColumnsType<InventoryExecutionRow> = [
      { title: "动作", dataIndex: "action", key: "action" },
      { title: "动作时间", dataIndex: "occurredAt", key: "occurredAt" },
      { title: "操作人", dataIndex: "operator", key: "operator" },
      {
        title: "金额",
        dataIndex: "amount",
        key: "amount",
        align: "right",
        render: (value: string) => <MoneyText value={value} />,
      },
      { title: "备注", dataIndex: "note", key: "note" },
    ];

    return <div className="inventory-detail">
    <Descriptions size="small" bordered column={{ xs: 1, sm: 2, md: 3 }}>
      <Descriptions.Item label="库存编号">{row.inventory_no}</Descriptions.Item>
      <Descriptions.Item label="建档操作人">{row.created_by || "-"}</Descriptions.Item>
      <Descriptions.Item label="登记时间">{dateTimeMinute(sourceOrder?.created_at ?? sourceOrder?.trade_date ?? row.created_at)}</Descriptions.Item>
      <Descriptions.Item label="出售时间">{eventDate(detail, "SELL")}</Descriptions.Item>
      <Descriptions.Item label="下架时间">{eventDate(detail, "CANCEL")}</Descriptions.Item>
      <Descriptions.Item label="寄售时间">{platformListingDate(detail)}</Descriptions.Item>
      <Descriptions.Item label="寄售平台">{consignmentPlatforms(detail)}</Descriptions.Item>
      <Descriptions.Item label="账号密码">
        {row.game_password ? <Typography.Text copyable>{row.game_password}</Typography.Text> : "-"}
      </Descriptions.Item>
      <Descriptions.Item label="渠道 / 区服">{row.channel_region || "-"}</Descriptions.Item>
      <Descriptions.Item label="绑定手机号">{row.bound_phone || "-"}</Descriptions.Item>
      <Descriptions.Item label="有无二次">{row.has_secondary == null ? "-" : row.has_secondary ? "有" : "无"}</Descriptions.Item>
      {PROFILE_ACCOUNT_TYPES.has(row.inventory_type ?? "") ? <>
        <Descriptions.Item label="账号描述" span={3}>{row.account_description || "-"}</Descriptions.Item>
        <Descriptions.Item label="账号图片" span={3}>
          {row.account_images?.length ? (
            <Image.PreviewGroup>
              <Space wrap>
                {row.account_images.slice(0, 9).map((src, index) => (
                  <Image key={`${src}-${index}`} src={src} alt={`账号图片 ${index + 1}`} width={64} height={64} preview />
                ))}
              </Space>
            </Image.PreviewGroup>
          ) : "-"}
        </Descriptions.Item>
      </> : null}
      <Descriptions.Item label="备注">{row.note || "-"}</Descriptions.Item>
    </Descriptions>
    <div className="inventory-execution-list">
      <Typography.Text strong>执行明细</Typography.Text>
      {executionRows.length ? (
        <DataTable
          className="inventory-execution-table"
          columns={executionColumns}
          rows={executionRows}
          page={1}
          pageSize={10}
          total={executionRows.length}
          onPageChange={() => undefined}
          pagination={false}
          rowKey="key"
          size="small"
        />
      ) : <Typography.Text type="secondary">暂无已执行事件</Typography.Text>}
    </div>
    <div className="inventory-finance-list">
      <div className="inventory-finance-heading">
        <Typography.Text strong>资金明细</Typography.Text>
        <Typography.Text type="secondary">{financialFlows.length + rebateItems.length} 笔</Typography.Text>
      </div>
      <div className="inventory-finance-summary">
        <div className="inventory-finance-summary__item">
          <span>支出</span>
          <strong>{expenseFlows.length} 笔</strong>
        </div>
        <div className="inventory-finance-summary__item">
          <span>收入</span>
          <strong>{incomeFlows.length} 笔</strong>
        </div>
        <div className="inventory-finance-summary__item inventory-finance-summary__item--amount">
          <span>总支出</span>
          <MoneyText value={totalExpense} />
        </div>
        <div className="inventory-finance-summary__item inventory-finance-summary__item--amount">
          <span>总收入</span>
          <MoneyText value={totalIncome} />
        </div>
      </div>
      <Typography.Text className="inventory-finance-note" type="secondary">
        汇总只统计已产生的资金流水，未结算返点不计入总收入
      </Typography.Text>
      {financeRows.length ? (
        <DataTable
          className="inventory-finance-table"
          columns={financeColumns}
          rows={financeRows}
          page={1}
          pageSize={10}
          total={financeRows.length}
          onPageChange={() => undefined}
          pagination={false}
          rowKey="key"
          scroll={{ x: 960 }}
          size="small"
        />
      ) : null}
      {!financialFlows.length && !rebateItems.length ? (
        <Typography.Text type="secondary">暂无资金明细</Typography.Text>
      ) : null}
    </div>
  </div>;
  };

  async function handleExpand(expanded: boolean, row: Account) {
    const rowKey = String(row.id);
    setExpandedAccountIds((current) => expanded ? [...current, rowKey] : current.filter((id) => id !== rowKey));
    if (!expanded || executionDetails[row.id] || executionLoading[row.id]) return;
    setExecutionLoading((current) => ({ ...current, [row.id]: true }));
    try {
      const detail = await accountsApi.executionDetail(row.id);
      setExecutionDetails((current) => ({ ...current, [row.id]: detail }));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setExecutionLoading((current) => ({ ...current, [row.id]: false }));
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const detailResults = await Promise.all(visibleRows.map(async (row) => {
        try {
          return [row.id, await accountsApi.executionDetail(row.id)] as const;
        } catch {
          return [row.id, undefined] as const;
        }
      }));
      const details = Object.fromEntries(detailResults) as Partial<Record<number, AccountExecutionDetail>>;
      const failedCount = detailResults.filter(([, detail]) => !detail).length;
      downloadInventoryCsv(visibleRows, details);
      if (failedCount) {
        message.warning(`${failedCount} 条明细读取失败，已导出其余可用字段`);
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="ui-stack">
      <ErrorBanner error={error} onRetry={() => void load()} />

      <StatRow
        items={[
          { label: "在库 / 分期中", kind: "count", amount: String(visibleOccupied.length) },
          { label: "占用成本合计", amount: totalCost },
          { label: "已售", kind: "count", amount: String(visibleRows.filter((r) => r.status === "SOLD").length) },
        ]}
      />

      <Card
        className="glass"
        title="账号台账"
        extra={
          <Space wrap>
            <PermissionButton
              permission="report.read"
              aria-label="导出"
              icon={<DownloadOutlined />}
              loading={exporting}
              onClick={() => void handleExport()}
            >
              导出
            </PermissionButton>
            <Select allowClear placeholder="按状态筛选" className="ui-control-width-inventory" value={status} options={STATUS_OPTIONS} onChange={(value) => { setStatus(value); setPage(1); }} />
            <Select allowClear placeholder="按业务筛选" className="ui-control-width-inventory" value={businessMode} options={BUSINESS_OPTIONS} onChange={(value) => { setBusinessMode(value); setPage(1); }} />
            <Select allowClear placeholder="按类型筛选" className="ui-control-width-inventory" value={inventoryType} options={INVENTORY_TYPE_OPTIONS} onChange={(value) => { setInventoryType(value); setPage(1); }} />
            <Input
              allowClear
              value={keyword}
              placeholder="搜索账号 / 产品 / 平台"
              aria-label="搜索库存账号"
              className="ui-control-width-history"
              onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
            />
          </Space>
        }
      >
        <DataTable<Account>
          columns={columns}
          rows={visibleRows}
          page={page}
          pageSize={pageSize}
          total={visibleRows.length}
          controlledPaging
          expandable={{
            expandedRowKeys: expandedAccountIds,
            expandedRowRender: renderInventoryDetail,
            expandRowByClick: true,
            onExpand: (expanded, row) => void handleExpand(expanded, row),
          }}
          emptyText="暂无账号"
          onPageChange={(nextPage, nextSize) => {
            setPage(nextPage);
            setPageSize(nextSize);
          }}
        />
      </Card>

      <InventorySaleModal
        account={saleTarget}
        onClose={() => setSaleTarget(null)}
        onCreated={async () => {
          setSaleTarget(null);
          await load();
        }}
      />
      <InventoryConsignmentModal
        account={consignmentTarget}
        onClose={() => setConsignmentTarget(null)}
        onCreated={async () => {
          setConsignmentTarget(null);
          await load();
        }}
      />
      <InventoryRebateModal
        account={rebateTarget}
        onClose={() => setRebateTarget(null)}
        onCreated={async () => {
          setRebateTarget(null);
          await load();
        }}
      />
      <Modal
        open={Boolean(profileTarget)}
        title={profileTarget?.mode === "images" ? "账号图片" : profileTarget?.mode === "description" ? "账号描述" : "编辑账号资料"}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingProfile}
        onCancel={() => setProfileTarget(null)}
        onOk={() => void saveProfile()}
      >
        {profileTarget?.mode === "images" ? (
          <Upload
            listType="picture-card"
            accept="image/*"
            maxCount={9}
            fileList={profileImages}
            beforeUpload={() => false}
            onChange={({ fileList }) => setProfileImages(fileList.slice(0, 9))}
          >
            <span aria-hidden="true">＋</span>
            <div>添加图片</div>
          </Upload>
        ) : profileTarget?.mode === "description" ? (
          <Input.TextArea
            rows={6}
            maxLength={2000}
            showCount
            value={profileForm.description}
            placeholder="补充账号等级、资源、限制等信息"
            onChange={(event) => setProfileForm((current) => ({ ...current, description: event.target.value }))}
          />
        ) : (
          <Space className="inventory-profile-editor" direction="vertical" size="middle">
            <Input aria-label="游戏账号" placeholder="游戏账号" value={profileForm.gameAccount} onChange={(event) => setProfileForm((current) => ({ ...current, gameAccount: event.target.value }))} />
            <Input aria-label="游戏类型" placeholder="游戏类型" value={profileForm.gameType} onChange={(event) => setProfileForm((current) => ({ ...current, gameType: event.target.value }))} />
            <Input.Password aria-label="账号密码" placeholder="账号密码" value={profileForm.gamePassword} onChange={(event) => setProfileForm((current) => ({ ...current, gamePassword: event.target.value }))} />
            <Input aria-label="渠道 / 区服" placeholder="渠道 / 区服" value={profileForm.channelRegion} onChange={(event) => setProfileForm((current) => ({ ...current, channelRegion: event.target.value }))} />
            <Input aria-label="绑定手机号" placeholder="绑定手机号" value={profileForm.boundPhone} onChange={(event) => setProfileForm((current) => ({ ...current, boundPhone: event.target.value }))} />
            <Input aria-label="平台" placeholder="平台" value={profileForm.platform} onChange={(event) => setProfileForm((current) => ({ ...current, platform: event.target.value }))} />
            <Select
              allowClear
              value={profileForm.hasSecondary == null ? undefined : profileForm.hasSecondary ? "有" : "无"}
              placeholder="有无二次"
              options={[{ value: "有", label: "有二次" }, { value: "无", label: "无二次" }]}
              onChange={(value) => setProfileForm((current) => ({ ...current, hasSecondary: value == null ? undefined : value === "有" }))}
            />
            <Input.TextArea rows={4} maxLength={2000} showCount value={profileForm.description} placeholder="账号描述" onChange={(event) => setProfileForm((current) => ({ ...current, description: event.target.value }))} />
            <Upload
              listType="picture-card"
              accept="image/*"
              maxCount={9}
              fileList={profileImages}
              beforeUpload={() => false}
              onChange={({ fileList }) => setProfileImages(fileList.slice(0, 9))}
            >
              <span aria-hidden="true">＋</span>
              <div>添加图片</div>
            </Upload>
            <Input.TextArea rows={3} value={profileForm.note} placeholder="账号备注" onChange={(event) => setProfileForm((current) => ({ ...current, note: event.target.value }))} />
          </Space>
        )}
      </Modal>
    </section>
  );
}

