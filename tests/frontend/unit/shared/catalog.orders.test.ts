import { describe, it, expect, vi, beforeEach } from "vitest";

// 受控 axios mock：transport 按 params.offset/limit 从一个共 627 条的数据集切片返回，
// 使用统一分页响应，验证订单列表客户端只读取后端分页信封。
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
      data: { items: pageData, total: TOTAL, limit, offset },
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
      map: Record<string, any>;

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
import { clearApiCache } from "@/shared/api/client";
import { ordersApi } from "@/shared/api/orders.api";

function apiInstance() {
  return (axios as any).__instances[0];
}

describe("ordersApi.listPage 分页契约", () => {
  beforeEach(() => {
    clearApiCache();
    (axios as any).__resetCalls();
  });

  it("按分页参数读取当前页与总数", async () => {
    const page = await ordersApi.listPage({ limit: 100, offset: 500, status: "COMPLETED" });
    expect(page.items).toHaveLength(100);
    expect(page.total).toBe(TOTAL);
    expect(page.limit).toBe(100);
    expect(page.offset).toBe(500);
    expect((axios as any).__getCallCount()).toBe(1);
    expect(apiInstance().request.mock.calls[0][0].params).toEqual({ limit: 100, offset: 500, status: "COMPLETED" });
  });

  it("默认分页参数由后端决定并保持响应信封", async () => {
    const page = await ordersApi.listPage();
    expect(page.items).toHaveLength(100);
    expect(page.total).toBe(TOTAL);
    expect((axios as any).__getCallCount()).toBe(1);
  });

  it("保留过滤参数且不在客户端自动翻页", async () => {
    await ordersApi.listPage({ order_type: "HS", limit: 50 });
    expect((axios as any).__getCallCount()).toBe(1);
    expect(apiInstance().request.mock.calls[0][0].params).toEqual({ order_type: "HS", limit: 50 });
  });

  it("不再暴露旧的自动翻页客户端方法", () => {
    expect("list" in ordersApi).toBe(false);
  });

  it("不再暴露旧订单摘要客户端方法", () => {
    expect("summary" in ordersApi).toBe(false);
  });
});
