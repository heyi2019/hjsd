import { beforeEach, describe, expect, it } from "vitest";
import {
  DEV_USER_KEY,
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
