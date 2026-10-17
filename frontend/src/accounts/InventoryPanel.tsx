/** 库存：以账号为载体的状态与成本（ACC-01 / RPT-01-01）。回收与代挂账号从这里进入在库流程。 */
import { DownloadOutlined } from "@ant-design/icons";
import { Card, Input, Modal, Select, Space, Upload, message } from "antd";
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
import { InventoryDetail } from "./InventoryDetail";
import { executionActionLabel } from "../shared/lib/format";
import {
  BUSINESS_MODE_LABEL,
  BUSINESS_OPTIONS,
  INVENTORY_TYPE_LABEL,
  INVENTORY_TYPE_OPTIONS,
  PROFILE_ACCOUNT_TYPES,
  STATUS_OPTIONS,
  accountFinancialFlows,
  financeTypeLabel,
  inventoryAge,
  inventoryStatusLabel,
  rebateTypeLabel,
} from "./inventory-logic";

const INVENTORY_EXPORT_HEADERS = [
  "订单号", "业务", "类型", "产品", "账号标识", "平台", "成本", "库存状态", "未售时长",
  "库存编号", "建档操作人", "登记时间", "出售时间", "下架时间", "寄售时间", "寄售平台",
  "账号密码", "渠道 / 区服", "绑定手机号", "有无二次", "账号描述", "账号图片", "备注", "执行明细", "资金明细",
  "支出笔数", "收入笔数", "总支出", "总收入",
];
function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function readImageData(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
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
  const financialFlows = accountFinancialFlows(detail);
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
        financeTypeLabel(event?.event_type ?? "", cashflow.direction),
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
            disabled={row.status !== 'IN_STOCK'}
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
              className="ui-control-width-inventory"
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
            expandedRowRender: (row) => (
            <InventoryDetail row={row} detail={executionDetails[row.id]} loading={Boolean(executionLoading[row.id])} />
          ),
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

