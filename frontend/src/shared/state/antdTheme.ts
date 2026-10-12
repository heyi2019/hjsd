/**
 * antd 主题工厂：把品牌令牌 + 暗色算法打包成 antd ThemeConfig。
 *
 * 关键：暗色下不能把 colorBgContainer / colorBgElevated 硬编码成 #ffffff，
 * 否则会盖掉 darkAlgorithm 推导出的深色表面，导致 antd 组件白底闯入暗色页面。
 * 此处随 mode 切换这两项为暗色令牌值（与 tokens.css --color-antd-bg-container 对齐）。
 */
import { theme as antdTheme, type ThemeConfig } from "antd";
import type { ThemeMode } from "./theme";

const BRAND = {
  colorPrimary: "#0a63d8",
  colorInfo: "#0a84ff",
  borderRadius: 10,
  controlHeight: 36,
  fontSize: 14,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif',
} as const;

export function buildTheme(mode: ThemeMode): ThemeConfig {
  if (mode === "dark") {
    return {
      algorithm: antdTheme.darkAlgorithm,
      token: {
        ...BRAND,
        colorBorder: "rgba(255,255,255,0.12)",
        colorBgContainer: "#14263e",
        colorBgElevated: "#14263e",
      },
    };
  }
  return {
    algorithm: antdTheme.defaultAlgorithm,
    token: {
      ...BRAND,
      colorBorder: "rgba(60,60,67,0.18)",
      colorBgContainer: "#ffffff",
      colorBgElevated: "#ffffff",
    },
  };
}
