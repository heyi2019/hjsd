import { describe, it, expect, vi, beforeEach } from "vitest";

// 在 jsdom 下用受控的 axios mock 验证 GET 缓存层三行为：
//  1) 并发去重：同一 GET 并发只发一次网络请求，调用方都拿到同一份数据；
//  2) 命中新鲜缓存：TTL 内再次 GET 前台瞬时返回缓存值（不阻塞网络）；
//  3) 写失效：POST 成功后清空 GET 缓存，下一次 GET 重新走网络拿到新值。
// 注意：client.ts 同时调用 axios.create 两次（api、transport），需按创建顺序区分实例。
vi.mock("axios", () => {
  const instances: any[] = [];
  let callCount = 0;
  const transportRequest = async (config: any) => {
    callCount += 1;
    return {
      data: `NET-${callCount}`,
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
    instances.push(inst);
    return inst;
  });
  const apiDefault = {
    create,
    // 与真实 axios 对齐：AxiosHeaders 构造器接受 headers 对象并支持 set/get
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
  return { default: apiDefault, create, __getCallCount: apiDefault.__getCallCount, __resetCalls: apiDefault.__resetCalls };
});

import axios from "axios";
import { clearApiCache } from "./client";

function apiInstance() {
  return (axios as any).__instances[0];
}

describe("GET 缓存层（并发去重 + SWR + 写失效）", () => {
  beforeEach(() => {
    clearApiCache();
    (axios as any).__resetCalls();
  });

  it("并发相同 GET 只发一次网络请求（去重）", async () => {
    const api = apiInstance();
    const [a, b] = await Promise.all([
      api.request({ method: "get", url: "/orders" }),
      api.request({ method: "get", url: "/orders" }),
    ]);
    expect(a.data).toBe(b.data);
    expect((axios as any).__getCallCount()).toBe(1);
  });

  it("TTL 内再次 GET 前台命中缓存（不阻塞网络）", async () => {
    const api = apiInstance();
    const first = await api.request({ method: "get", url: "/orders" });
    const cached = await api.request({ method: "get", url: "/orders" });
    // 前台返回的是缓存值，与首请求一致（证明被缓存短路，而非重新走网络）
    expect(cached.data).toBe(first.data);
    expect(cached.data).toMatch(/^NET-\d+$/);
  });

  it("POST 成功后清空 GET 缓存，下次 GET 走网络拿新值（写失效）", async () => {
    const api = apiInstance();
    const g1 = await api.request({ method: "get", url: "/orders" });
    const cached = await api.request({ method: "get", url: "/orders" });
    expect(cached.data).toBe(g1.data); // 缓存生效

    // 写操作成功
    const created = await api.request({ method: "post", url: "/orders", data: { order_type: "HS", trade_date: "2026-10-28" } });
    expect(created.status).toBe(200);

    const g2 = await api.request({ method: "get", url: "/orders" });
    // 缓存被清空，重新走网络，拿到与 g1 不同的新响应
    expect(g2.data).not.toBe(g1.data);
    expect(g2.data).toMatch(/^NET-\d+$/);
  });

  it("首访 GET 只发一次网络请求（不双倍发送）", async () => {
    const api = apiInstance();
    await api.request({ method: "get", url: "/orders" });
    expect((axios as any).__getCallCount()).toBe(1);
  });

  it("不同 URL 的 GET 互不影响（缓存按 key 区分）", async () => {
    const api = apiInstance();
    const a = await api.request({ method: "get", url: "/orders" });
    const b = await api.request({ method: "get", url: "/customers" });
    expect(a.data).not.toBe(b.data);
    expect((axios as any).__getCallCount()).toBe(2);
  });

  it("超 TTL 但在 MAX_STALE 窗口内：前台立即返回陈旧值，后台静默重验", async () => {
    const api = apiInstance();
    const nowSpy = vi.spyOn(Date, "now");
    let fake = Date.now();
    nowSpy.mockImplementation(() => fake);
    try {
      const first = await api.request({ method: "get", url: "/orders" });
      expect(first.data).toBe("NET-1");
      expect((axios as any).__getCallCount()).toBe(1);

      fake += 10_000; // 超过 TTL(3s)，未超 MAX_STALE(30s)
      const stale = await api.request({ method: "get", url: "/orders" });
      // 前台仍返回陈旧值 NET-1：证明未被网络阻塞（否则会等待并拿到 NET-2）
      expect(stale.data).toBe("NET-1");
      await new Promise((r) => setTimeout(r, 0)); // 让后台重验 microtask 落地
      // 后台重验已发起：切走再切回 tab 不再卡网络往返
      expect((axios as any).__getCallCount()).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("远超 MAX_STALE：不再返回陈旧值，改为等待新鲜响应", async () => {
    const api = apiInstance();
    const nowSpy = vi.spyOn(Date, "now");
    let fake = Date.now();
    nowSpy.mockImplementation(() => fake);
    try {
      const first = await api.request({ method: "get", url: "/orders" });
      expect(first.data).toBe("NET-1");
      fake += 60_000; // 超过 MAX_STALE(30s)
      const fresh = await api.request({ method: "get", url: "/orders" });
      // 必须等待网络拿到新值 NET-2，而非陈旧 NET-1
      expect(fresh.data).toBe("NET-2");
      expect((axios as any).__getCallCount()).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
