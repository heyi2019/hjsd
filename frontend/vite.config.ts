import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // 页面从局域网地址打开时，浏览器会将直连 127.0.0.1 视为跨网络请求。
  // 开发时统一走同源路径，由 Vite 在本机转发到后端，避免 CORS/PNA 拦截。
  server: {
    proxy: {
      "/api/v1": {
        target: "http://127.0.0.1:8123",
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          antd: ["antd", "@ant-design/icons"],
        },
      },
    },
  },
});
