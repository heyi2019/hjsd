import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import axios, { type AxiosAdapter } from "axios";
import {
  api,
  ACCESS_TOKEN_KEY,
  DEV_USER_KEY,
  checkBackendHealth,
  changePassword,
  currentDevUser,
  errorMessage,
  normalizeError,
  logout,
  setDevUser,
} from "@/shared/api/client";

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

  it("客户访问保护不可用时保留后端可执行的 503 提示", () => {
    const err = axiosError({ status: 503, responseData: { code: "RATE_LIMIT_STORE_UNAVAILABLE", message: "客户访问保护暂不可用，请稍后重试" } });
    expect(normalizeError(err)).toEqual({ code: "RATE_LIMIT_STORE_UNAVAILABLE", message: "客户访问保护暂不可用，请稍后重试" });
  });

  it("结构化 5xx 的英文原文不上屏，统一降级为中文兜底", () => {
    const err = axiosError({ status: 500, responseData: { code: "INTERNAL", message: "boom" } });
    expect(normalizeError(err)).toEqual({
      message: "后端接口返回异常，请查看后端日志。",
      code: "BACKEND_ERROR",
    });
  });

  it("4xx 业务中文文案原样透出，不被 5xx 兜底误伤", () => {
    const err = axiosError({ status: 422, responseData: { code: "BUSINESS_ERROR", message: "业务校验未通过" } });
    expect(normalizeError(err)).toEqual({ message: "业务校验未通过", code: "BUSINESS_ERROR" });
  });

  it("非 axios 错误也能安全转文案（不抛错即为达标）", () => {
    expect(normalizeError("boom")).toEqual({ message: "boom" });
    // 现状：实现走 String(error)，Error 会带 "Error: " 前缀。
    // 这里锁定现状而非理想值；若要改成纯 message，需同步改 client.ts 与本断言。
    expect(normalizeError(new Error("炸了")).message).toBe("Error: 炸了");
  });
});

it("旧退出请求完成后不会清除新登录令牌", async () => {
  localStorage.setItem(ACCESS_TOKEN_KEY, "old-token");
  let finish!: () => void;
  const request = vi.spyOn(api, "post").mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ data: { ok: true } } as never); }));
  const pending = logout();
  expect(request).toHaveBeenCalledWith("/auth/logout", undefined, { headers: { Authorization: "Bearer old-token" } });
  expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  localStorage.setItem(ACCESS_TOKEN_KEY, "new-token");
  finish();
  await pending;
  expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("new-token");
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  request.mockRestore();
});

it("凭证失效时结束对应会话，旧请求和错误密码不会退出新会话", async () => {
  vi.stubEnv("DEV", false);
  const expired = vi.fn();
  window.addEventListener("erp:session-expired", expired);
  const failure = (code: string, message: string): AxiosAdapter => async (config) => {
    throw new axios.AxiosError(message, "ERR_BAD_REQUEST", config, undefined, { config, status: 401, statusText: "Unauthorized", headers: {}, data: { code, message } });
  };
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, "active-token");
    await expect(api.get("/orders", { bypassCache: true, adapter: failure("TOKEN_EXPIRED", "登录已过期，请重新登录") } as never)).rejects.toThrow();
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
    expired.mockClear();
    localStorage.setItem(ACCESS_TOKEN_KEY, "active-token");
    await expect(api.post("/auth/change-password", {}, { adapter: failure("AUTH_REQUIRED", "原密码错误") })).rejects.toThrow();
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("active-token");
    expect(expired).not.toHaveBeenCalled();
    let rejectOld!: (reason: unknown) => void;
    let oldConfig: Parameters<AxiosAdapter>[0];
    const pending = api.get("/orders", { bypassCache: true, adapter: (config: Parameters<AxiosAdapter>[0]) => {
      oldConfig = config;
      return new Promise((_resolve, reject) => { rejectOld = reject; });
    } } as never);
    await vi.waitFor(() => expect(rejectOld).toBeDefined());
    localStorage.setItem(ACCESS_TOKEN_KEY, "new-token");
    rejectOld(new axios.AxiosError("失效", "ERR_BAD_REQUEST", oldConfig!, undefined, { config: oldConfig!, status: 401, statusText: "Unauthorized", headers: {}, data: { code: "SESSION_INVALIDATED", message: "请重新登录" } }));
    await expect(pending).rejects.toThrow();
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("new-token");
    expect(expired).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("erp:session-expired", expired);
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    vi.unstubAllEnvs();
  }
});

describe("errorMessage：展示层统一文案", () => {
  it("带 code 时只展示用户可执行的中文 message", () => {
    const err = axiosError({ responseData: { code: "POOL_ROUTE_MISSING", message: "缺少资金路由" } });
    expect(errorMessage(err)).toBe("缺少资金路由");
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

describe("changePassword：会话操作超时边界", () => {
  it("改密后更新当前会话令牌，并保留另一个已登录会话", async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, "old-token");
    const request = vi.spyOn(api, "post").mockResolvedValueOnce({ data: { access_token: "updated-token" } } as never);
    await changePassword("old-pass", "new-pass-123");
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("updated-token");
    let finish!: () => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ data: { access_token: "stale-token" } } as never); }));
    const pending = changePassword("old-pass", "new-pass-123");
    localStorage.setItem(ACCESS_TOKEN_KEY, "new-login");
    finish();
    await pending;
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("new-login");
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    request.mockRestore();
  });
  it("改密要求传入当前密码字符串，不保留旧的空值兼容", () => {
    expectTypeOf(changePassword).parameter(0).toEqualTypeOf<string>();
  });

  it("缺少当前密码时立即拒绝且不发送请求", async () => {
    const request = vi.spyOn(api, "post").mockResolvedValue({ data: undefined } as never);
    await expect(changePassword("" as never, "new-pass-123")).rejects.toThrow("当前密码不能为空");
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
  });

  it("改密请求使用 5 秒超时，避免错误旧密码长时间卡在 loading", async () => {
    const request = vi.spyOn(api, "post").mockResolvedValue({ data: undefined } as never);
    await changePassword("old-pass", "new-pass-123");
    expect(request).toHaveBeenCalledWith(
      "/auth/change-password",
      { old_password: "old-pass", new_password: "new-pass-123" },
      { timeout: 5_000 },
    );
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

describe("API 客户端：仅走本地后端", () => {
  it("不再暴露云端模式开关", async () => {
    const clientModule = await import("@/shared/api/client");
    expect("CLOUD_MODE" in clientModule).toBe(false);
  });
});
