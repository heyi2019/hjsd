import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  DEV_USER_KEY,
  checkBackendHealth,
  currentDevUser,
  errorMessage,
  normalizeError,
  setDevUser,
} from "./client";

/** 组装一个 axios.isAxiosError 认账的错误对象（不必真发请求）。 */
function axiosError(opts: {
  responseData?: unknown;
  status?: number;
  message?: string;
  code?: string;
  hasResponse?: boolean;
}): unknown {
  const err: Record<string, unknown> = {
    isAxiosError: true,
    name: "AxiosError",
    message: opts.message ?? "Request failed",
  };
  if (opts.hasResponse !== false) {
    err.response = { status: opts.status ?? 400, data: opts.responseData };
  }
  if (opts.code) err.code = opts.code;
  return err;
}

describe("normalizeError：只认 v1 统一错误结构", () => {
  it("统一结构 { code, message }", () => {
    const err = axiosError({ responseData: { code: "VALIDATION_ERROR", message: "金额不能为负" } });
    expect(normalizeError(err)).toEqual({ message: "金额不能为负", code: "VALIDATION_ERROR" });
  });

  it("不再兼容旧 detail 结构，统一结构优先", () => {
    const err = axiosError({
      responseData: { code: "X", message: "业务体", detail: { message: "框架体", code: "Y" } },
    });
    expect(normalizeError(err)).toEqual({ message: "业务体", code: "X" });
  });

  it("无响应体（后端不可达/CORS/超时）不抛错，给出可读文案", () => {
    const err = axiosError({ hasResponse: false, message: "Network Error" });
    const out = normalizeError(err);
    expect(typeof out.message).toBe("string");
    expect(out.message.length).toBeGreaterThan(0);
  });

  it("后端返回未结构化 500 时提示接口异常而不是误报连接失败", () => {
    const err = axiosError({ status: 500, responseData: "Internal Server Error" });
    expect(normalizeError(err)).toEqual({
      message: "后端接口返回异常，请查看后端日志。",
      code: "BACKEND_ERROR",
    });
  });

  it("健康检查返回 503 时提示后端或数据库未就绪", () => {
    const err = axiosError({ status: 503, responseData: { status: "error", database_status: "unavailable" } });
    expect(normalizeError(err).message).toContain("后端");
  });

  it("结构化 5xx 的英文原文不上屏，统一降级为中文兜底", () => {
    const err = axiosError({ status: 500, responseData: { code: "INTERNAL", message: "boom" } });
    expect(normalizeError(err)).toEqual({
      message: "后端接口返回异常，请查看后端日志。",
      code: "BACKEND_ERROR",
    });
  });

  it("4xx 业务中文文案原样透出，不被 5xx 兜底误伤", () => {
    const err = axiosError({ status: 422, responseData: { code: "PERIOD_LOCKED", message: "期间已锁定" } });
    expect(normalizeError(err)).toEqual({ message: "期间已锁定", code: "PERIOD_LOCKED" });
  });

  it("非 axios 错误也能安全转文案（不抛错即为达标）", () => {
    expect(normalizeError("boom")).toEqual({ message: "boom" });
    // 现状：实现走 String(error)，Error 会带 "Error: " 前缀。
    // 这里锁定现状而非理想值；若要改成纯 message，需同步改 client.ts 与本断言。
    expect(normalizeError(new Error("炸了")).message).toBe("Error: 炸了");
  });
});

describe("errorMessage：展示层统一文案", () => {
  it("带 code 时拼成 `code: message`", () => {
    const err = axiosError({ responseData: { code: "POOL_ROUTE_MISSING", message: "缺少资金路由" } });
    expect(errorMessage(err)).toBe("POOL_ROUTE_MISSING: 缺少资金路由");
  });

  it("无 code 时只给 message", () => {
    const err = axiosError({ responseData: { message: "校验失败" } });
    expect(errorMessage(err)).toBe("校验失败");
  });
});

describe("checkBackendHealth：启动前置检查", () => {
  it("请求统一健康接口", async () => {
    const request = vi.spyOn(api, "get").mockResolvedValue({ data: { status: "ok" } } as never);
    await checkBackendHealth();
    expect(request).toHaveBeenCalledWith("/health", { timeout: 3_000 });
    request.mockRestore();
  });
});

describe("dev user：X-Dev-User 角色切换", () => {
  beforeEach(() => {
    localStorage.removeItem(DEV_USER_KEY);
  });

  it("未设置时默认 admin", () => {
    expect(currentDevUser()).toBe("admin");
  });

  it("setDevUser 写入 localStorage 且可读回", () => {
    setDevUser("finance");
    expect(localStorage.getItem(DEV_USER_KEY)).toBe("finance");
    expect(currentDevUser()).toBe("finance");
  });
});
