import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("开发服务器 API 转发", () => {
  it("将同源 /api/v1 请求转给本机后端", () => {
    // 这里校验配置源文件，避免 jsdom 的 TextEncoder shim 干扰 Vite/esbuild 的加载。
    const config = readFileSync(`${process.cwd()}/vite.config.ts`, "utf8");

    expect(config).toContain('"/api/v1"');
    expect(config).toContain('target: "http://127.0.0.1:8123"');
    expect(config).toContain("changeOrigin: true");
  });
});
