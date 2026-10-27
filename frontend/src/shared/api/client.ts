import axios from "axios";

/** 后端基址：本地联调 8123（8000 被 Docker 占用），与 docs/ERP_本地开发与联调指南_v1.0.md 一致。 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8123/api/v1";

/** dev 直通用户：后端以 `X-Dev-User` 识别；切换角色即可验证权限显隐。 */
export const DEV_USER_KEY = "hj.dev-user";
export const ACCESS_TOKEN_KEY = "hj.access-token";

export function currentDevUser(): string {
  return localStorage.getItem(DEV_USER_KEY) || "admin";
}

export function setDevUser(user: string): void {
  localStorage.setItem(DEV_USER_KEY, user);
}

export const api = axios.create({ baseURL: API_BASE, timeout: 15_000 });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  else config.headers["X-Dev-User"] = currentDevUser();
  return config;
});

// ---- GET 轻量缓存：并发去重 + 短 TTL 陈旧重验（SWR） ----
// 背景：性能压测发现页面/弹窗「换页慢」主要源于 useReloadOnActive 每次切页全量重拉、
// 列表不分页全量拉取，以及多组件挂载并发打同一接口。本层在共享客户端统一收敛：
//  1) 并发相同 GET 只发一次请求，其余复用（去重）；
//  2) 命中新鲜缓存立即返回，并后台静默重验更新（stale-while-revalidate）；
//  3) 任何写操作（POST/PUT/PATCH/DELETE）成功后清空全部 GET 缓存，
//     保证建单/取消后再次读取立即可见最新数据。
// 设计边界：TTL 仅 3s，避免长期服务陈旧数据；仅缓存成功响应（不缓存 5xx/网络错误）。
const GET_CACHE_TTL_MS = 3_000;

interface CacheEntry {
  data: unknown;
  status: number;
  headers: unknown;
  expireAt: number;
}

const responseCache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<CacheEntry>>();

// 纯传输层：复用相同 baseURL 与默认 xhr adapter，但不挂载本项目拦截器，
// 供缓存层直接发起真实网络请求（避免与缓存拦截器相互递归）。
const transport = axios.create({ baseURL: API_BASE, timeout: 15_000 });

function buildCacheKey(config: { method?: string; url?: string; params?: unknown; headers?: Record<string, unknown> }): string {
  const headers = (config.headers as Record<string, unknown>) || {};
  const auth =
    (headers.Authorization as string) ||
    (headers["X-Dev-User"] as string) ||
    (typeof (headers as { get?: (k: string) => unknown }).get === "function"
      ? ((headers as { get: (k: string) => unknown }).get("Authorization") as string) ||
        ((headers as { get: (k: string) => unknown }).get("X-Dev-User") as string)
      : "") ||
    "";
  const params = config.params ? JSON.stringify(config.params) : "";
  return `${String(config.method || "get").toUpperCase()} ${auth} ${config.url ?? ""} ${params}`;
}

async function realSend(config: any): Promise<CacheEntry> {
  // transport 复用 baseURL + xhr adapter 但**不挂载本项目拦截器**，
  // 因此 GET 请求在缓存拦截器（注册在后、先执行）抢先发出时，
  // api 的鉴权拦截器（注册在前、后执行）尚未注入 X-Dev-User，
  // 导致 header 缺失 → 后端 401「未登录或凭证已失效」。
  // 在此显式补 dev 鉴权头，与 api 的鉴权拦截器保持同源口径。
  const headers = new axios.AxiosHeaders(config.headers);
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  else headers.set("X-Dev-User", currentDevUser());
  const cfg = {
    ...config,
    headers,
    adapter: undefined,
    transformRequest: config.transformRequest,
    transformResponse: config.transformResponse,
  };
  const resp = await transport.request(cfg);
  return { data: resp.data, status: resp.status, headers: resp.headers, expireAt: Date.now() + GET_CACHE_TTL_MS };
}

function fakeResponse(entry: CacheEntry): any {
  return { data: entry.data, status: entry.status, statusText: "OK", headers: entry.headers, config: {}, request: {} };
}

function dedupAdapter(key: string, config: any): any {
  return async () => {
    const p = pending.get(key);
    if (!p) {
      // pending 已被写失效清掉（竞态），退化为实时请求
      return fakeResponse(await realSend(config));
    }
    return fakeResponse(await p);
  };
}

function swrAdapter(key: string, config: any): any {
  return async () => {
    const cached = responseCache.get(key)!;
    // 前台立即返回陈旧值；后台静默重验，失败则保留旧值
    realSend(config)
      .then((entry) => responseCache.set(key, entry))
      .catch(() => undefined);
    return fakeResponse(cached);
  };
}

api.interceptors.request.use((config: any) => {
  const method = String(config.method || "get").toUpperCase();
  if (method !== "GET") return config; // 写操作不参与缓存，仅触发失效（见响应拦截器）
  const key = buildCacheKey(config);
  const now = Date.now();
  if (pending.has(key)) {
    config.adapter = dedupAdapter(key, config);
    return config;
  }
  const cached = responseCache.get(key);
  if (cached && cached.expireAt > now) {
    config.adapter = swrAdapter(key, config);
    return config;
  }
  const p = realSend(config)
    .then((entry) => {
      responseCache.set(key, entry);
      return entry;
    })
    .finally(() => {
      pending.delete(key);
    });
  pending.set(key, p);
  // 必须设置 adapter，否则 axios 默认适配器会再发一次请求（与 realSend 重复）
  config.adapter = async () => fakeResponse(await p);
  return config;
});

/** 清空全部 GET 缓存（写操作成功后自动调用；亦供测试在 beforeEach 重置客户端状态）。 */
export function clearApiCache(): void {
  responseCache.clear();
  pending.clear();
}

export type SessionUser = { id: number; username: string; role: string; display_name: string; must_change_password?: boolean };

export async function login(username: string, password: string) {
  const response = await api.post<{ access_token: string; user: SessionUser }>("/auth/login", { username, password });
  localStorage.setItem(ACCESS_TOKEN_KEY, response.data.access_token);
  return response.data.user;
}

export async function currentUser(): Promise<SessionUser> {
  return (await api.get<SessionUser>("/auth/me")).data;
}

/** 启动/登录前置检查：确认后端和数据库已就绪。 */
export async function checkBackendHealth(): Promise<void> {
  await api.get("/health", { timeout: 3_000 });
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await api.post("/auth/change-password", { old_password: oldPassword, new_password: newPassword });
}

export async function logout(): Promise<void> {
  try { await api.post("/auth/logout"); } finally { localStorage.removeItem(ACCESS_TOKEN_KEY); }
}

/** 后端不可达标记：页面据此显示「连接失败」横幅，而不是静默渲染空态。
 *  典型场景：后端未启动 / 端口错 / CORS 预检被拒 —— 三者都表现为 response 为空。 */
let lastNetworkFailure: { url: string; reason: string } | null = null;

api.interceptors.response.use(
  (response: any) => {
    lastNetworkFailure = null;
    // 任何写操作成功后清空 GET 缓存，保证建单/取消后再次读取立即可见最新数据
    const method = String(response.config?.method || "get").toUpperCase();
    if (method !== "GET" && response.status >= 200 && response.status < 300) {
      clearApiCache();
    }
    return response;
  },
  (error) => {
    if (axios.isAxiosError(error) && !error.response) {
      const url = String(error.config?.url ?? "");
      lastNetworkFailure = {
        url,
        reason: error.code === "ECONNABORTED" ? "请求超时" : "无法连接后端",
      };
      // 便于在浏览器控制台直接定位，不必翻 Network 面板。
      console.error(
        `[API] 后端不可达：${lastNetworkFailure.reason} ${API_BASE}${url}` +
          (error.message ? ` (${error.message})` : ""),
      );
    }
    return Promise.reject(error);
  },
);

/** 读取当前后端连接状态；无失败记录或已恢复时返回 null。 */
export function backendConnectionError(): string | null {
  if (!lastNetworkFailure) return null;
  return `${lastNetworkFailure.reason}：${API_BASE}${lastNetworkFailure.url}。` +
    "请确认后端已启动且端口正确；若页面数据为空但无报错，通常是 CORS 拒绝了本端口。";
}

/** 从 axios 错误里抽出 v1 统一错误体。 */
export interface NormalizedError {
  message: string;
  code?: string;
}

export function normalizeError(error: unknown): NormalizedError {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { code?: string; message?: string }
      | undefined;

    // 5xx 一律降级为中文兜底：后端业务异常（AppError）全部落在 4xx，其 message 为中文且带可执行
    // 业务语义，必须原样透出；而 5xx 只可能来自未捕获异常或网关故障，其 message 对终端用户无操作
    // 价值且可能携带堆栈/英文技术串。此处先行拦截，避免英文原文直接上屏。
    if (error.response && error.response.status >= 500) {
      return error.response.status === 503
        ? {
            message: "后端服务未连接或启动异常，请检查后端服务和端口。",
            code: "BACKEND_UNAVAILABLE",
          }
        : {
            message: "后端接口返回异常，请查看后端日志。",
            code: "BACKEND_ERROR",
          };
    }

    // v1 唯一错误结构：{ code, message, details }
    if (data?.message) return { message: data.message, code: data.code };

    // 无响应体：后端不可达 / 超时 / 被 CORS 拒绝
    if (!error.response) {
      return { message: backendConnectionError() ?? error.message };
    }
    return { message: error.message };
  }
  return { message: String(error) };
}

/** 统一错误文案：后端只返回 v1 统一结构 { code, message, details }。
 *  展示层只透出中文 message；code 是英文缩写，对终端用户无操作价值，
 *  仅打 console 便于排查，不上屏（曾以 `AUTH_REQUIRED: 用户名或密码错误` 直出登录页）。 */
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const { message, code } = normalizeError(error);
    if (code) console.debug(`[API] ${code}: ${message}`);
    return message;
  }
  return String(error);
}
