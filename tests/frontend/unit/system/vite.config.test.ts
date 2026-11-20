import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// HERE = <repo>/tests/frontend/unit/system
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("开发服务器 API 转发", () => {
  it("将同源 /api 请求转给本机后端", () => {
    // 直接读配置源文件，避免 jsdom 的 TextEncoder shim 干扰 Vite/esbuild 的加载。
    // 路径从本文件位置推算，不依赖 process.cwd()：vitest root 是仓库根，而 npm 脚本
    // 的 cwd 是 frontend/，两者不一致时用 cwd 拼路径会读错文件。
    const config = readFileSync(path.join(REPO, "frontend", "vite.config.ts"), "utf8");

    expect(config).toContain('"/api"');
    expect(config).toContain('loadEnv(mode, process.cwd(), "")');
    expect(config).toContain("process.env.VITE_BACKEND_PORT");
    expect(config).toContain("process.env.ERP_E2E_BACKEND_PORT");
    expect(config).toContain("env.VITE_BACKEND_PORT");
    expect(config).toContain('target: `http://127.0.0.1:${backendPort}`');
    expect(config).toContain("changeOrigin: true");
  });
});
