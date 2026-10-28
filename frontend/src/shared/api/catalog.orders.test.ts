import { describe, it, expect, vi, beforeEach } from "vitest";

// 受控 axios mock：transport 按 params.offset/limit 从一个共 627 条的数据集切片返回，
// 验证 ordersApi.list 在无显式 limit 时自动翻页取全量、显式 limit 时单发透传。
const TOTAL = 627;

vi.mock("axios", () => {
  const instances: any[] = [];
  let callCount = 0;
  const transportRequest = async (config: any) => {
    callCount += 1;
    const params = config.params || {};
    const offset = Number(params.offset || 0);
    const limit = Number(params.limit || 100);
    const slice = Math.max(0, Math.min(limit, TOTAL - offset));
    const pageData = Array.from({ length: slice }, (_, i) => ({ id: offset + i + 1 }));
    return {
      data: pageData,
      status: 200,
      headers: {},
      config: { method: String(config.method || "get").toUpperCase() },
    };
  };
  const create = vi.fn((cfg: any) => {
    const reqHandlers: any[] = [];
    const resHandlers: any[] = [];
    const inst: any = {
      defaults: { baseURL: cfg?.baseURL, adapter: undefined },
      interceptors: {
        request: { use: (fn: any) => reqHandlers.push(fn) },
        response: { use: (fn: any) => resHandlers.push(fn) },
      },
      request: vi.fn(async (config: any) => {
        let cfg = { ...config, headers: { ...(config.headers || {}) } };
        for (const h of reqHandlers) cfg = (await h(cfg)) ?? cfg;
        let response: any;
        if (typeof cfg.adapter === "function") {
          response = await cfg.adapter(cfg);
        } else {
          response = await transportRequest(cfg);
        }
        let resp = response;
        for (const h of resHandlers) resp = (await h(resp)) ?? resp;
        return resp;
      }),
    };
    // axios 便捷方法：转发到 request
    for (const m of ["get", "post", "put", "patch", "delete"]) {
      inst[m] = (url: string, bodyOrCfg?: any, maybeCfg?: any) => {
        if (m === "get" || m === "delete") {
          return inst.request({ ...(bodyOrCfg || {}), method: m, url });
        }
        return inst.request({ ...(maybeCfg || {}), method: m, url, data: bodyOrCfg });
      };
    }
    instances.push(inst);
    return inst;
  });
  const apiDefault = {
    create,
    AxiosHeaders: class {
      constructor(h: any) {
        this.map = h || {};
      }
      set(k: string, v: string) {
        this.map[k] = v;
        return this;
      }
      get(k: string) {
        return this.map[k];
      }
    },
    __instances: instances,
    __getCallCount: () => callCount,
    __resetCalls: () => {
      callCount = 0;
    },
  };
  return {
    default: apiDefault,
    create,
    __getCallCount: apiDefault.__getCallCount,
    __resetCalls: apiDefault.__resetCalls,
  };
});

import axios from "axios";
import { clearApiCache } from "./client";
import { ordersApi } from "./catalog";

function apiInstance() {
  return (axios as any).__instances[0];
}

describe("ordersApi.list 自动翻页取全量", () => {
  beforeEach(() => {
    clearApiCache();
    (axios as any).__resetCalls();
  });

  it("无显式 limit 时翻页取全量（627 条 → 500+127，2 次请求）", async () => {
    const orders = await ordersApi.list();
    expect(orders.length).toBe(TOTAL);
    expect((axios as any).__getCallCount()).toBe(2);
  });

  it("显式传入 limit 时单发透传（不翻页）", async () => {
    const orders = await ordersApi.list({ limit: 100 });
    expect(orders.length).toBe(100);
    expect((axios as any).__getCallCount()).toBe(1);
  });

  it("带过滤参数时仍翻页且透传过滤条件", async () => {
    const orders = await ordersApi.list({ order_type: "HS" });
    expect(orders.length).toBe(TOTAL);
    expect((axios as any).__getCallCount()).toBe(2);
    // 两次请求都带 order_type=HS
    const calls = apiInstance().request.mock.calls;
    for (const c of calls) {
      const cfg = c[0];
      expect(cfg.params.order_type).toBe("HS");
    }
  });
});
