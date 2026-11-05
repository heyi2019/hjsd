import { describe, expect, it } from "vitest";
import { buildTheme } from "@/shared/state/antdTheme";

describe("antdTheme.buildTheme：暗色/亮色令牌切换", () => {
  it("亮色模式使用默认算法与白底容器", () => {
    const theme = buildTheme("light");
    expect(theme.algorithm).toBeDefined();
    expect((theme.token as { colorBgContainer: string }).colorBgContainer).toBe("#ffffff");
    expect((theme.token as { colorLink: string }).colorLink).toBe("#0a63d8");
  });

  it("暗色模式使用 darkAlgorithm 与深色容器令牌", () => {
    const theme = buildTheme("dark");
    // darkAlgorithm 是 antd 内部函数，只断言它确实被挂上且深色容器生效。
    expect(theme.algorithm).toBeDefined();
    expect((theme.token as { colorBgContainer: string }).colorBgContainer).toBe("#14263e");
    expect((theme.token as { colorTextSecondary: string }).colorTextSecondary).toBe("rgba(219,234,250,0.85)");
  });
});
