import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// HERE = <repo>/tests/frontend/unit/system
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

it("快速层的纯脚本测试运行在 Node 环境", () => {
  expect(typeof document).toBe("undefined");
});

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


describe("响应式断点", () => {
  it("样式不使用未配置转换的自定义媒体查询", () => {
    const root = path.join(REPO, "frontend/src");
    const cssFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const name = path.join(dir, entry.name);
      return entry.isDirectory() ? cssFiles(name) : name.endsWith(".css") ? [name] : [];
    });
    const invalid = cssFiles(root).filter((file) => /@media\s*\(\s*--[\w-]+\s*\)/.test(readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
    expect(invalid.map((file) => path.relative(root, file))).toEqual([]);
  });
});
