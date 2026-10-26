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
  (response) => {
    lastNetworkFailure = null;
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

/** 统一错误文案：后端只返回 v1 统一结构 { code, message, details }。 */
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const { message, code } = normalizeError(error);
    return code ? `${code}: ${message}` : message;
  }
  return String(error);
}
