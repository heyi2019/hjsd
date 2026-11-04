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
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          // 拆成三个缓存层，目的是**让业务改动不再污染第三方包的 hash**：
          //  - react：React 运行时 + 路由，一年动不了几次；
          //  - antd ：antd + @ant-design + rc-* / @rc-component，升级组件库才变；
          //  - 其余（业务代码 + 小型依赖）：每天随业务提交而变。
          //
          // 注意：antd/rc-* 内部存在循环依赖，纯按包名列表拆（对象式）容易抽出
          // 互相引用的 chunk 导致运行时 `Cannot access before initialization`。
          // 这里用函数式并**只归拢 node_modules 内的模块**，让 Rollup 自己决定
          // 剩余模块归属；构建后必须核对无 "Circular" 告警且页面可启动。
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
              return "react";
            }
            if (/[\\/]node_modules[\\/](antd|@ant-design|rc-[^\\/]+|@rc-component)[\\/]/.test(id)) {
              return "antd";
            }
            return undefined;
          },
        },
      },
    },
  };
});
