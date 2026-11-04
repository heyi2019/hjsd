/** 云端预览环境的公共配置（activate 返回，全部为可公开的 publishable 信息，无密钥）。 */
export const CLOUD_PUBLIC_CONFIG = {
  endpoint: "https://yyxuan-erp-preview.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_RuvvSocMWWv718cmitkxuo_XLyLV8Kqj6iWnFvtJL3FgrgcMlybO5AI",
} as const;

/**
 * 数据源判定：发布域自动切到云端，本地 / ECS 仍走原 FastAPI。
 * 显式 VITE_DATA_SOURCE=backend 可强制回退到原后端（回滚开关），
 * VITE_DATA_SOURCE=cloud 可在任意环境强制验证云链路。
 */
export function isCloudMode(): boolean {
  const forced = import.meta.env.VITE_DATA_SOURCE;
  if (forced === "cloud") return true;
  if (forced === "backend") return false;
  try {
    const host = window.location.hostname;
    return host.endsWith(".app.workbuddy.host") || host.endsWith(".workbuddy.link");
  } catch {
    return false;
  }
}
