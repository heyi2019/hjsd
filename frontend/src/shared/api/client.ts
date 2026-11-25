import axios, { type AxiosAdapter, type AxiosRequestConfig, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";

/** 后端基址：本地联调 8123（8000 被 Docker 占用）；后端绑 0.0.0.0，局域网可直连。 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8123/api";

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
export type CacheAwareRequestConfig = AxiosRequestConfig & {
  refreshCache?: boolean;
  /** 用于每次都必须到达后端的 GET，例如需要逐次记录审计的导出。 */
  bypassCache?: boolean;
};

api.interceptors.request.use((config) => {
  const token = import.meta.env.DEV ? null : localStorage.getItem(ACCESS_TOKEN_KEY);
  if (!config.headers.has("Authorization")) {
    if (token) config.headers.Authorization = `Bearer ${token}`;
    else config.headers["X-Dev-User"] = currentDevUser();
  }
  return config;
});

// ---- GET 轻量缓存：并发去重 + 陈旧重验（真 SWR） ----
// 背景：性能压测发现页面/弹窗「换页慢」主要源于 useReloadOnActive 每次切页全量重拉、
// 列表不分页全量拉取，以及多组件挂载并发打同一接口。本层在共享客户端统一收敛：
//  1) 并发相同 GET 只发一次请求，其余复用（去重）；
//  2) 命中缓存立即返回（即便已超 TTL，只要在 MAX_STALE 窗口内也先返回陈旧值），
//     并后台静默重验更新（stale-while-revalidate）——切走再切回 tab 不再阻塞于网络往返；
//  3) 任何写操作（POST/PUT/PATCH/DELETE）成功后清空全部 GET 缓存，
//     保证建单/取消后再次读取立即可见最新数据。
// 设计边界：TTL 仅 3s（决定后台重验频率）；MAX_STALE 30s（决定「多陈旧的缓存仍敢先返回」）；
// 仅缓存成功响应（不缓存 5xx/网络错误）。安全网：写操作清空缓存，停留期间若有写则下次必走网络。
const GET_CACHE_TTL_MS = 3_000;
// 陈旧容忍窗口：超过 TTL 但在该窗口内仍先返回缓存值并后台重验，避免「切走稍久再切回」也卡网络。
const GET_CACHE_MAX_STALE_MS = 30_000;
const GET_CACHE_MAX_ENTRIES = 256;

interface CacheEntry {
  data: unknown;
  status: number;
  headers: AxiosResponse["headers"];
  expireAt: number;
}

const responseCache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<CacheEntry>>();
const refreshPending = new Map<string, Promise<CacheEntry>>();
let cacheGeneration = 0;

function cacheResponse(key: string, entry: CacheEntry): void {
  const cutoff = Date.now() - GET_CACHE_MAX_STALE_MS;
  for (const [cachedKey, cached] of responseCache) {
    if (cached.expireAt <= cutoff) responseCache.delete(cachedKey);
  }
  responseCache.delete(key);
  responseCache.set(key, entry);
  while (responseCache.size > GET_CACHE_MAX_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest === undefined) break;
    responseCache.delete(oldest);
  }
}

// 纯传输层：复用相同 baseURL 与默认 xhr adapter，但不挂载本项目拦截器，
// 供缓存层直接发起真实网络请求（避免与缓存拦截器相互递归）。
const transport = axios.create({ baseURL: API_BASE, timeout: 15_000 });

function buildCacheKey(config: Pick<AxiosRequestConfig, "method" | "url" | "params" | "headers">): string {
  // 请求拦截器按后注册先执行：此处可能还没注入认证头，直接使用实际会话身份区分缓存。
  const token = import.meta.env.DEV ? null : localStorage.getItem(ACCESS_TOKEN_KEY);
  const auth = token ? `Bearer ${token}` : currentDevUser();
  const params = config.params ? JSON.stringify(config.params) : "";
  return `${String(config.method || "get").toUpperCase()} ${auth} ${config.url ?? ""} ${params}`;
}

async function realSend(config: InternalAxiosRequestConfig): Promise<CacheEntry> {
  // transport 复用 baseURL + xhr adapter 但**不挂载本项目拦截器**，
  // 因此 GET 请求在缓存拦截器（注册在后、先执行）抢先发出时，
  // api 的鉴权拦截器（注册在前、后执行）尚未注入 X-Dev-User，
  // 导致 header 缺失 → 后端 401「未登录或凭证已失效」。
  // 在此显式补 dev 鉴权头，与 api 的鉴权拦截器保持同源口径。
  const headers = new axios.AxiosHeaders(config.headers);
  const token = import.meta.env.DEV ? null : localStorage.getItem(ACCESS_TOKEN_KEY);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  else headers.set("X-Dev-User", currentDevUser());
  const cfg: AxiosRequestConfig = {
    ...config,
    headers,
    // realSend 是缓存层的真实网络出口，不能继承 api 请求上的去重/SWR 临时 adapter，
    // 否则后台重验会再次进入自身，形成递归。
    adapter: undefined,
    transformRequest: config.transformRequest,
    transformResponse: config.transformResponse,
  };
  const resp = await transport.request(cfg);
  return { data: resp.data, status: resp.status, headers: resp.headers, expireAt: Date.now() + GET_CACHE_TTL_MS };
}

function fakeResponse(entry: CacheEntry): AxiosResponse {
  return {
    data: entry.data,
    status: entry.status,
    statusText: "OK",
    headers: entry.headers,
    config: { headers: new axios.AxiosHeaders() } as InternalAxiosRequestConfig,
    request: {},
  };
}

function dedupAdapter(key: string, config: InternalAxiosRequestConfig): AxiosAdapter {
  return async () => {
    const p = pending.get(key);
    if (!p) {
      // pending 已被写失效清掉（竞态），退化为实时请求
      return fakeResponse(await realSend(config));
    }
    return fakeResponse(await p);
  };
}

function startCachedRequest(key: string, config: InternalAxiosRequestConfig): Promise<CacheEntry> {
  const generation = cacheGeneration;
  const request = realSend(config)
    .then((entry) => {
      // 只有当前请求能写缓存，强制刷新、清空缓存或更新的请求会使旧请求失效。
      if (generation === cacheGeneration && pending.get(key) === request) cacheResponse(key, entry);
      return entry;
    })
    .finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
  pending.set(key, request);
  return request;
}

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const method = String(config.method || "get").toUpperCase();
  if (method !== "GET" || config.responseType === "blob" || config.responseType === "arraybuffer"
    || (config as InternalAxiosRequestConfig & CacheAwareRequestConfig).bypassCache) return config;
  const key = buildCacheKey(config);
  if ((config as InternalAxiosRequestConfig & CacheAwareRequestConfig).refreshCache) {
    let request = refreshPending.get(key);
    if (!request) {
      responseCache.delete(key);
      pending.delete(key);
      request = startCachedRequest(key, config);
      refreshPending.set(key, request);
      const current = request;
      const clear = () => { if (refreshPending.get(key) === current) refreshPending.delete(key); };
      void request.then(clear, clear);
    }
    const current = request;
    config.adapter = async () => fakeResponse(await current);
    return config;
  }
  const now = Date.now();
  const cached = responseCache.get(key);
  if (cached && cached.expireAt > now - GET_CACHE_MAX_STALE_MS) {
    responseCache.delete(key);
    responseCache.set(key, cached);
  } else if (cached) {
    responseCache.delete(key);
  }
  if (cached && cached.expireAt > now) {
    config.adapter = async () => fakeResponse(cached);
    return config;
  }
  if (cached && cached.expireAt > now - GET_CACHE_MAX_STALE_MS) {
    if (!pending.has(key)) void startCachedRequest(key, config).catch(() => undefined);
    config.adapter = async () => fakeResponse(cached);
    return config;
  }
  if (pending.has(key)) {
    config.adapter = dedupAdapter(key, config);
    return config;
  }
  const request = startCachedRequest(key, config);
  config.adapter = async () => fakeResponse(await request);
  return config;
});

/** 清空全部 GET 缓存，并丢弃失效前尚未完成的结果。 */
export function clearApiCache(): void {
  cacheGeneration += 1;
  responseCache.clear();
  pending.clear();
  refreshPending.clear();
}

export type SessionUser = { id: number; username: string; role: string; display_name: string; must_change_password?: boolean };
let authGeneration = 0;

export async function login(username: string, password: string) {
  const generation = ++authGeneration;
  const response = await api.post<{ access_token: string; user: SessionUser }>("/auth/login", { username, password });
  if (generation !== authGeneration) throw new Error("登录请求已失效，请重试");
  localStorage.setItem(ACCESS_TOKEN_KEY, response.data.access_token);
  clearApiCache();
  return response.data.user;
}

export async function currentUser(): Promise<SessionUser> {
  return (await api.get<SessionUser>("/auth/me", { bypassCache: true } as CacheAwareRequestConfig)).data;
}

/** 启动/登录前置检查：确认后端和数据库已就绪。 */
export async function checkBackendHealth(): Promise<void> {
  await api.get("/health", { timeout: 3_000 });
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  if (!oldPassword.trim()) throw new Error("当前密码不能为空");
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  const generation = authGeneration;
  const body = { old_password: oldPassword, new_password: newPassword };
  // 会话安全操作不能沿用普通请求的 15 秒等待；失败或旧密码错误时应尽快回到可重试状态。
  const response = await api.post<{ access_token?: string }>("/auth/change-password", body, { timeout: 5_000 });
  if (token && generation === authGeneration && localStorage.getItem(ACCESS_TOKEN_KEY) === token) {
    if (!response.data?.access_token) throw new Error("改密成功但未能更新登录凭证，请重新登录");
    localStorage.setItem(ACCESS_TOKEN_KEY, response.data.access_token);
    clearApiCache();
  }
}

export async function changeUsername(username: string, currentPassword: string): Promise<SessionUser> {
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  const generation = authGeneration;
  const { data } = await api.post<{ access_token: string; user: SessionUser }>("/auth/change-username", {
    username, current_password: currentPassword,
  });
  if (generation === authGeneration && token && localStorage.getItem(ACCESS_TOKEN_KEY) === token) {
    localStorage.setItem(ACCESS_TOKEN_KEY, data.access_token);
  }
  return data.user;
}

export async function logout(): Promise<void> {
  authGeneration += 1;
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  clearApiCache();
  await api.post("/auth/logout", undefined, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
}


/** 后端不可达标记：页面据此显示「连接失败」横幅，而不是静默渲染空态。
 *  典型场景：后端未启动 / 端口错 / CORS 预检被拒 —— 三者都表现为 response 为空。 */
let lastNetworkFailure: { url: string; reason: string } | null = null;

api.interceptors.response.use(
  (response: AxiosResponse) => {
    lastNetworkFailure = null;
    // 任何写操作成功后清空 GET 缓存，保证建单/取消后再次读取立即可见最新数据
    const method = String(response.config?.method || "get").toUpperCase();
    if (method !== "GET" && response.status >= 200 && response.status < 300) {
      clearApiCache();
    }
    return response;
  },
  (error) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      const payload = error.response.data as { code?: string; message?: string } | undefined;
      const token = localStorage.getItem(ACCESS_TOKEN_KEY);
      const sentAuth = new axios.AxiosHeaders(error.config?.headers).get("Authorization");
      const path = String(error.config?.url ?? "");
      const excluded = path.endsWith("/auth/login") || path.endsWith("/auth/logout")
        || (path.endsWith("/auth/change-password") && payload?.code !== "SESSION_INVALIDATED" && payload?.code !== "TOKEN_EXPIRED");
      if (token && sentAuth === `Bearer ${token}` && !excluded) {
        authGeneration += 1;
        localStorage.removeItem(ACCESS_TOKEN_KEY);
        clearApiCache();
        window.dispatchEvent(new CustomEvent("erp:session-expired", { detail: { message: payload?.message || "登录已失效，请重新登录" } }));
      }
    }
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

    // 已知的服务依赖错误有明确业务提示；未知 5xx 仍用兜底，避免暴露堆栈。
    if (error.response?.status === 503 && data?.code === "RATE_LIMIT_STORE_UNAVAILABLE" && data.message) {
      return { message: data.message, code: data.code };
    }
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
