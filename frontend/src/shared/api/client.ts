import axios from "axios";

/** 后端基址：本地联调 8123（8000 被 Docker 占用），与 docs/ERP_本地开发与联调指南_v1.0.md 一致。 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8123/api/v1";

/** dev 直通用户：后端以 `X-Dev-User` 识别；切换角色即可验证权限显隐。 */
export const DEV_USER_KEY = "hj.dev-user";

export function currentDevUser(): string {
  return localStorage.getItem(DEV_USER_KEY) || "admin";
}

export function setDevUser(user: string): void {
  localStorage.setItem(DEV_USER_KEY, user);
}

export const api = axios.create({ baseURL: API_BASE, timeout: 15_000 });

api.interceptors.request.use((config) => {
  config.headers["X-Dev-User"] = currentDevUser();
  return config;
});

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

/** 从 axios 错误里抽出后端业务错误体。
 *  后端实际存在**两种**结构，缺一不可：
 *   1. 业务异常：`{ code, message, details }`（顶层，如 VALIDATION_ERROR）
 *   2. FastAPI 框架错误：`{ detail: { message, code } | string }`（校验/404/405）
 *  只认其中一种会导致错误码丢失、ErrorBanner 提示退化成通用文案。 */
export interface NormalizedError {
  message: string;
  code?: string;
}

export function normalizeError(error: unknown): NormalizedError {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { code?: string; message?: string; detail?: unknown }
      | undefined;

    // 形态 2：{ detail: { message, code } } —— 页面各处的既有读法
    const detail = data?.detail as { message?: string; code?: string } | undefined;
    if (detail?.message) return { message: detail.message, code: detail.code };

    // 形态 1：{ code, message } —— 业务异常处理器
    if (data?.message) return { message: data.message, code: data.code };

    // 无响应体：后端不可达 / 超时 / 被 CORS 拒绝
    if (!error.response) {
      return { message: backendConnectionError() ?? error.message };
    }
    return { message: error.message };
  }
  return { message: String(error) };
}

/** 统一错误文案：后端返回 { code, message, details } 或 { detail: {...} }。 */
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const { message, code } = normalizeError(error);
    return code ? `${code}: ${message}` : message;
  }
  return String(error);
}
