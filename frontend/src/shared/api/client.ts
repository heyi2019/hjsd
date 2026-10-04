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

/** 统一错误文案：后端返回 { code, message, details }。 */
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string; code?: string } | undefined;
    if (data?.message) return `${data.code ?? "ERROR"}: ${data.message}`;
    return error.message;
  }
  return String(error);
}
