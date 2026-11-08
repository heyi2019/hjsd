import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// 与 vitest.config.ts 保持同一套别名定义。两处分叉会让「测试能解析、构建不能」
// 或反之，且症状是运行期才暴露。
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendPort =
    process.env.VITE_BACKEND_PORT
    ?? process.env.ERP_E2E_BACKEND_PORT
    ?? env.VITE_BACKEND_PORT
    ?? env.ERP_E2E_BACKEND_PORT
    ?? "8123";

  // dev（server）与 preview 共用同一套 /api/v1 代理：E2E 用 preview 模式（见
  // playwright.config.ts），若只在 server 段配代理，preview 会连不上后端。
  const apiProxy = {
    "/api/v1": {
      target: `http://127.0.0.1:${backendPort}`,
      changeOrigin: true,
    },
  };

  // E2E 走 `vite build --mode e2e` + preview：preview 是 production 构建产物，
  // import.meta.env.DEV 在 build 时恒为 false，但 E2E 依赖 DEV 真值走零登录直通
  // （session.tsx:108 的 authenticated 默认 import.meta.env.DEV）。故 e2e 模式强制
  // define DEV 为 true，仅作用于 E2E 构建，不影响 development / production 构建。
  const define = mode === "e2e" ? { "import.meta.env.DEV": "true" } : {};

  return {
    plugins: [react()],
    define,
    resolve: {
      alias: { "@": here("./src") },
    },
    // 页面从局域网地址打开时，浏览器会将直连 127.0.0.1 视为跨网络请求。
    // 开发时统一走同源路径，由 Vite 在本机转发到后端，避免 CORS/PNA 拦截。
    server: {
      host: "0.0.0.0",
      proxy: apiProxy,
    },
    // preview 段代理与 server 完全一致：E2E 走 `vite build + vite preview` 时，
    // 前端的 /api/v1 请求须同样转发到本套 E2E 后端端口（8124）。
    preview: {
      host: "0.0.0.0",
      proxy: apiProxy,
    },
    build: {
      // 当前最大按需块约 322KB；600KB 预警线足够容纳组件库升级，也能及时拦截重新合包。
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          // 保留 React 运行时缓存层，避免业务改动污染稳定的第三方包 hash。
          //  - react：React 运行时 + 路由，一年动不了几次；
          // antd/rc-* 不强制合成单一大块，交给 Rollup 按动态页面入口拆分，
          // 避免首屏为未访问的页面加载全部组件库。
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
              return "react";
            }
            const normalized = id.replaceAll("\\\\", "/");
            const rcGroups: Array<[RegExp, string]> = [
              [/\/node_modules\/rc-table\//, "antd-table"],
              [/\/node_modules\/rc-pagination\//, "antd-table"],
              [/\/node_modules\/(?:rc-picker|rc-field-form|rc-select|rc-tree-select|rc-virtual-list|rc-input|rc-input-number|@rc-component\/async-validator)\//, "antd-controls"],
              [/\/node_modules\/rc-upload\//, "antd-upload"],
              [/\/node_modules\/rc-tabs\//, "antd-tabs"],
            ];
            for (const [pattern, chunk] of rcGroups) {
              if (pattern.test(normalized)) return chunk;
            }
            return undefined;
          },
        },
      },
    },
  };
});
