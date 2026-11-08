/**
 * 云端数据源传输层：把 /api/v1 的请求改由 WorkBuddy Cloud SDK 直接读取云数据库。
 *
 * 设计边界：
 * - 只在发布域（或 VITE_DATA_SOURCE=cloud）启用，本地 5188 / ECS 仍走原 FastAPI；
 * - 复用 axios adapter 接口，业务 API 无需感知数据源；
 * - 云端是 heijin_erp_release 的只读快照，写操作一律返回明确的业务错误，不静默造假成功。
 */
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { CLOUD_PUBLIC_CONFIG } from "./config";

type Row = Record<string, unknown>;
type CloudDatabase = { from: (table: string) => any };

let databasePromise: Promise<CloudDatabase> | null = null;

async function database(): Promise<CloudDatabase> {
  if (!databasePromise) {
    databasePromise = import("@tencent-ai/workbuddy-cloud-sdk")
      .then((sdk) => (sdk.createWorkBuddyCloud(CLOUD_PUBLIC_CONFIG) as any).database as CloudDatabase)
      .catch((err: unknown) => {
        databasePromise = null;
        throw err;
      });
  }
  return databasePromise;
}

const TABLE_BY_ROOT: Record<string, string> = {
  orders: "orders",
  stocks: "stocks",
  cashflows: "cashflow",
  customers: "customers",
  counterparties: "counterparties",
  leads: "customer_leads",
  installments: "installments",
  deposits: "deposits",
  "game-types": "game_type_options",
  notifications: "notifications",
  "option-sets": "option_sets",
  "order-types": "order_type_defs",
  "order-form-fields": "order_form_fields",
  "list-columns": "list_column_configs",
  users: "users",
  teams: "teams",
  policies: "policy_definitions",
  "policy-versions": "policy_versions",
  pools: "pools",
  reconciliations: "reconciliations",
  rebates: "rebate_records",
  "audit-logs": "audit_logs",
  transfers: "cashflow",
};

const TABLE_BY_SUBPATH: Record<string, string> = {
  "orders/links": "order_links",
  "orders/profit-allocations": "order_profit_allocations",
  "orders/customer-roles": "order_customer_roles",
  "order-types/routes": "order_type_pools",
  "installments/schedules": "installment_schedules",
  "installments/dispositions": "installment_dispositions",
  "list-columns/custom-fields": "list_custom_columns",
};

const IGNORED_PARAMS = new Set([
  "limit", "offset", "_t", "mine", "all_people", "include_inactive", "unread_only",
  "group", "editable", "from", "to", "on", "entity_types", "status", "export",
]);

/** 语义上是查询、但用 POST 发出的端点（预览环境允许，返回空结果）。 */
const QUERY_POST_PATHS = new Set([
  "/installments/mark-overdue",
]);

const PREVIEW_USER = {
  id: 1,
  username: "admin",
  display_name: "预览管理员",
  role: "ADMIN",
  must_change_password: false,
};

function parseBody(config: InternalAxiosRequestConfig): Record<string, unknown> {
  try {
    const raw = config.data;
    if (!raw) return {};
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseRequest(config: InternalAxiosRequestConfig): { path: string; params: Record<string, string> } {
  const raw = String(config.url ?? "/");
  const withoutOrigin = raw.replace(/^https?:\/\/[^/]+/, "");
  const withoutBase = withoutOrigin.replace(/^\/?api\/v1/, "");
  const [pathPart, queryPart] = withoutBase.split("?");
  const path = (pathPart.startsWith("/") ? pathPart : `/${pathPart}`).replace(/\/+$/, "") || "/";
  const params: Record<string, string> = {};
  if (queryPart) {
    for (const [key, value] of new URLSearchParams(queryPart)) params[key] = value;
  }
  const fromConfig = config.params as Record<string, unknown> | undefined;
  if (fromConfig) {
    for (const [key, value] of Object.entries(fromConfig)) {
      if (value != null && value !== "") params[key] = String(value);
    }
  }
  return { path, params };
}

function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { data, status: 200, statusText: "OK", headers: {}, config };
}

function fail(config: InternalAxiosRequestConfig, status: number, code: string, message: string): never {
  const error: any = new Error(message);
  error.isAxiosError = true;
  error.config = config;
  error.response = { status, data: { code, message } };
  throw error;
}

function cloudFailure(config: InternalAxiosRequestConfig, cause: unknown): never {
  const raw = cause as { message?: string } | null;
  const detail = typeof raw?.message === "string" ? raw.message : String(cause ?? "未知错误");
  return fail(config, 400, "CLOUD_REQUEST_FAILED", `云服务请求失败：${detail}`);
}

/** 统一集合响应的数组访问、分页元数据与汇总字段。 */
function collection(rows: Row[], params: Record<string, string>): Row[] & Record<string, unknown> {
  const limit = params.limit ? Number(params.limit) : undefined;
  const offset = params.offset ? Number(params.offset) : 0;
  const page = limit != null && limit > 0 ? rows.slice(offset, offset + limit) : rows.slice(offset);
  const out = page.slice() as Row[] & Record<string, unknown>;
  out.items = page.slice();
  out.rows = page.slice();
  out.total = rows.length;
  out.count = rows.length;
  out.limit = limit ?? rows.length;
  out.offset = offset;
  out.unread_total = 0;
  out.total_in = "0.00";
  out.total_out = "0.00";
  out.approved_income = "0.00";
  out.approved_expense = "0.00";
  out.approved_net = "0.00";
  out.total_cost = "0.00";
  out.totals = {};
  out.summary = {};
  out.groups = [];
  out.series = [];
  out.actions = [];
  out.stats = [];
  out.trend = [];
  return out;
}

function single(row: Row | undefined): Row {
  const base: Row = { ...(row ?? {}) };
  const emptyArrays = [
    "items", "links", "events", "schedules", "dispositions", "customer_roles",
    "counterparty_roles", "profit_allocations", "rows", "attachments", "versions",
  ];
  for (const key of emptyArrays) if (!(key in base)) base[key] = [];
  return base;
}

async function fetchRows(table: string, params: Record<string, string>): Promise<Row[]> {
  const db = await database();
  const { data, error } = await db.from(table).select("*").order("id", { ascending: true });
  if (error) return Promise.reject(error);
  let rows: Row[] = Array.isArray(data) ? (data as Row[]) : [];
  for (const [key, value] of Object.entries(params)) {
    if (IGNORED_PARAMS.has(key) || !rows.length || !(key in rows[0])) continue;
    if (key === "keyword") {
      const needle = value.toLowerCase();
      rows = rows.filter((row) => Object.values(row).some((v) => typeof v === "string" && v.toLowerCase().includes(needle)));
    } else {
      rows = rows.filter((row) => String(row[key] ?? "") === value);
    }
  }
  return rows;
}

function csvBlob(rows: Row[]): Blob {
  if (!rows.length) return new Blob(["\uFEFF"], { type: "text/csv;charset=utf-8" });
  const keys = Object.keys(rows[0]);
  const cell = (value: unknown) => {
    const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = [keys.join(","), ...rows.map((row) => keys.map((k) => cell(row[k])).join(","))];
  return new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
}

function resolveTable(segments: string[]): string | undefined {
  const root = segments[0];
  if (segments.length >= 3) {
    const two = `${root}/${segments[2]}`;
    if (TABLE_BY_SUBPATH[two]) return TABLE_BY_SUBPATH[two];
    const one = `${root}/${segments[1]}`;
    if (TABLE_BY_SUBPATH[one]) return TABLE_BY_SUBPATH[one];
  }
  return TABLE_BY_ROOT[root];
}

/** 子集合按路径里的父 id 过滤，列名取行里真实存在的那一个。 */
function parentFilter(segments: string[], rows: Row[]): Row[] {
  if (segments.length < 3 || !rows.length) return rows;
  const parentId = segments[1];
  if (!/^\d+$/.test(parentId)) return rows;
  const candidates = ["order_id", "order_type_id", "installment_id", "batch_id", "pool_id"];
  const key = candidates.find((candidate) => candidate in rows[0]);
  if (!key) return rows;
  return rows.filter((row) => String(row[key] ?? "") === parentId);
}

export const cloudAdapter: AxiosAdapter = async (config) => {
  const method = String(config.method ?? "get").toUpperCase();
  const { path, params } = parseRequest(config);
  const segments = path.split("/").filter(Boolean);

  // ---- 会话与健康检查（预览环境免密，账号与口令哈希不上云）----
  if (path === "/health") return ok(config, { status: "ok", source: "workbuddy-cloud" });
  if (path === "/auth/login") {
    const username = (() => {
      try {
        const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
        return typeof body?.username === "string" && body.username ? body.username : "admin";
      } catch { return "admin"; }
    })();
    return ok(config, { access_token: "cloud-preview-token", user: { ...PREVIEW_USER, username } });
  }
  if (path === "/auth/me") return ok(config, PREVIEW_USER);
  if (path === "/auth/logout") return ok(config, {});
  // 云端预览没有短信通道与微信通道，也没有可写的账号体系：一律如实报「未启用」，
  // 让登录页不点亮这三个入口，而不是点了之后拿到一个必然失败的 404。
  if (path === "/auth/login-methods") {
    return ok(config, {
      password: { enabled: true },
      phone_code: { enabled: false, dev_code_visible: false },
      wechat: { enabled: false, configured: false, provider: "disabled", verify_mode: "sms", reason: "云端预览为只读快照，不支持免密登录" },
    });
  }

  // 库存库龄/占用成本：云端按同一份库存数据现算，避免卡片出现 undefined。
  if (path === "/stocks/inventory/stats") {
    try {
      const ids = new Set(((parseBody(config).account_ids as number[] | undefined) ?? []).map(Number));
      const rows = await fetchRows("stocks", {});
      const target = ids.size ? rows.filter((row) => ids.has(Number(row.id))) : rows;
      const now = Date.now();
      const ageDays = (row: Row) => {
        const raw = row.inventory_entry_at ?? row.buy_date;
        const ts = raw ? new Date(String(raw)).getTime() : NaN;
        return Number.isFinite(ts) ? (now - ts) / 86_400_000 : 0;
      };
      const occupied = target.reduce((sum, row) => sum + (Number(row.cost_amount) || 0), 0);
      return ok(config, {
        account_count: target.length,
        occupied_cost: occupied.toFixed(2),
        over_7d_count: target.filter((row) => ageDays(row) > 7).length,
        over_30d_count: target.filter((row) => ageDays(row) > 30).length,
      });
    } catch (err) {
      return cloudFailure(config, err);
    }
  }

  // ---- 写操作：只读快照，明确拒绝而不是假装成功 ----
  if (method !== "GET") {
    if (QUERY_POST_PATHS.has(path)) return ok(config, collection([], params));
    if (path === "/auth/change-password") {
      return fail(config, 403, "CLOUD_READ_ONLY", "云端预览为只读快照，修改密码请在本地或生产系统操作。");
    }
    return fail(config, 403, "CLOUD_READ_ONLY", "云端预览为只读数据快照，写操作请在本地或生产系统执行。");
  }

  // ---- 导出：直接由云表生成 CSV / 占位 xlsx ----
  if (/\.(csv|xlsx)$/.test(segments[segments.length - 1] ?? "")) {
    const root = segments[0];
    const table = TABLE_BY_ROOT[root] ?? "orders";
    try {
      const rows = await fetchRows(table, {});
      return ok(config, csvBlob(rows));
    } catch (err) {
      return cloudFailure(config, err);
    }
  }

  // ---- 特殊只读形状 ----
  if (path === "/stocks/inventory") {
    try {
      const rows = await fetchRows("stocks", {});
      const inStock = rows.filter((row) =>
        String(row.inventory_status ?? "") === "IN_STOCK" || String(row.status ?? "") === "WAITING");
      const total = inStock.reduce((sum, row) => sum + (Number(row.cost_amount) || 0), 0);
      const result = collection(inStock, params);
      result.count = inStock.length;
      result.total_cost = total.toFixed(2);
      return ok(config, result);
    } catch (err) {
      return cloudFailure(config, err);
    }
  }

  if (segments[0] === "reports" ||
      path === "/pools/balances" || path === "/cashflows/studio-summary" || path.endsWith("/balance")) {
    // 聚合类端点依赖后端业务规则，预览环境返回结构完整的空结果，不伪装数值。
    return ok(config, collection([], params));
  }

  if (path === "/order-form-fields/scopes") {
    try {
      const rows = await fetchRows("order_form_fields", {});
      const scopes = [...new Set(rows.map((r) => String(r.order_type_code ?? "")))].filter(Boolean);
      return ok(config, collection(scopes.map((scope) => ({ scope, code: scope, label: scope })), params));
    } catch (err) {
      return cloudFailure(config, err);
    }
  }

  // ---- 通用表查询 ----
  const table = resolveTable(segments);
  if (!table) return ok(config, collection([], params));

  try {
    let rows = await fetchRows(table, params);
    rows = parentFilter(segments, rows);

    // 单条：/resource/:id（或 /option-sets/:code）
    if (segments.length === 2 && !IGNORED_PARAMS.has(segments[1])) {
      const key = /^\d+$/.test(segments[1]) ? "id" : "code";
      const match = rows.find((row) => String(row[key] ?? "") === segments[1]);
      return ok(config, single(match ?? rows[0]));
    }
    return ok(config, collection(rows, params));
  } catch (err) {
    return cloudFailure(config, err);
  }
};
