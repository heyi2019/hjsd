import { afterEach, vi } from "vitest";

if (typeof document === "undefined") {
  afterEach(() => {
    vi.resetAllMocks();
  });
} else {
  // 显式使用 jsdom 的快速测试仍保留完整的组件清理和浏览器状态重置。
  await import("./setup");
}
