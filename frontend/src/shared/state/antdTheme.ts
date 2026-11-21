/**
 * antd 主题工厂：把品牌令牌 + 暗色算法打包成 antd ThemeConfig。
 *
 * 关键：暗色下不能把 colorBgContainer / colorBgElevated 硬编码成 #ffffff，
 * 否则会盖掉 darkAlgorithm 推导出的深色表面，导致 antd 组件白底闯入暗色页面。
 * 此处随 mode 切换这两项为暗色令牌值（与 tokens.css --color-antd-bg-container 对齐）。
 */
import { theme as antdTheme, type ThemeConfig } from "antd";
import type { ResolvedThemeMode } from "./theme";

const COMPONENTS = { Button: { controlHeightSM: 24 } } as const;

const BRAND = {
  colorPrimary: "#0a63d8",
  colorInfo: "#0a84ff",
  borderRadius: 10,
  controlHeight: 36,
  fontSize: 14,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif',
} as const;

export function buildTheme(mode: ResolvedThemeMode): ThemeConfig {
  if (mode === "dark") {
    return {
      algorithm: antdTheme.darkAlgorithm,
      components: COMPONENTS,
      token: {
        ...BRAND,
        colorBorder: "rgba(255,255,255,0.12)",
        colorBgContainer: "#14263e",
        colorBgElevated: "#14263e",
        // 文本层级令牌：覆盖 antd v5 默认过淡值（占位符 rgba(0,0,0,.25)≈1.84、三级≈3.x），
        // 拉到深色底可达 AA（≥4.5）。占位符/三级/四级统一用提亮蓝白，描述/次级更高。
        colorTextPlaceholder: "rgba(219,234,250,0.65)",
        colorTextTertiary: "rgba(219,234,250,0.65)",
        colorTextQuaternary: "rgba(219,234,250,0.65)",
        colorTextDescription: "rgba(219,234,250,0.85)",
        colorTextSecondary: "rgba(219,234,250,0.85)",
        // 链接蓝：默认 colorLink 取 info 蓝（#0a84ff≈3.63，未达 AA）；压深到品牌主蓝
        // （#0a63d8≈5.54）覆盖表格行内动作链接（售出/寄售/返点/编辑）与 Typography.Link。
        colorLink: "#0a63d8",
      },
    };
  }
  return {
    algorithm: antdTheme.defaultAlgorithm,
    components: COMPONENTS,
    token: {
      ...BRAND,
      colorBorder: "rgba(60,60,67,0.18)",
      colorBgContainer: "#ffffff",
      colorBgElevated: "#ffffff",
      // 文本层级令牌：覆盖 antd v5 默认过淡值，拉到白底可达 AA（≥4.5）。
      // 占位符 #6e6e73≈4.65、三级/四级同值；描述/次级 #48484a≈7.0。
      colorTextPlaceholder: "#6e6e73",
      colorTextTertiary: "#6e6e73",
      colorTextQuaternary: "#6e6e73",
      colorTextDescription: "#48484a",
      colorTextSecondary: "#48484a",
      colorLink: "#0a63d8",
    },
  };
}
