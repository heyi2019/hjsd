import { describe, it, expect, vi, beforeEach } from "vitest";

// 在 jsdom 下用受控的 axios mock 验证 GET 缓存层三行为：
//  1) 并发去重：同一 GET 并发只发一次网络请求，调用方都拿到同一份数据；
//  2) 命中新鲜缓存：TTL 内再次 GET 前台瞬时返回缓存值（不阻塞网络）；
//  3) 写失效：POST 成功后清空 GET 缓存，下一次 GET 重新走网络拿到新值。
// 注意：client.ts 同时调用 axios.create 两次（api、transport），需按创建顺序区分实例。
vi.mock("axios", async (importOriginal) => {
  const original = await importOriginal<typeof import("axios")>();
  const { AxiosHeaders } = original;
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
        let cfg = { ...config, headers: new AxiosHeaders(config.headers) };
        for (const h of reqHandlers.slice().reverse()) cfg = (await h(cfg)) ?? cfg;
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
    inst.get = (url: string, config: any = {}) => inst.request({ ...config, method: "get", url });
    instances.push(inst);
    return inst;
  });
  const apiDefault = {
    ...original.default,
    create,
    AxiosHeaders,
    __instances: instances,
    __getCallCount: () => callCount,
    __resetCalls: () => {
      callCount = 0;
    },
  };
  return { ...original, default: apiDefault, create, __getCallCount: apiDefault.__getCallCount, __resetCalls: apiDefault.__resetCalls };
});

import axios from "axios";
import { clearApiCache, setDevUser } from "@/shared/api/client";
import { reportsApi } from "@/shared/api/reports.api";
import { workbenchApi } from "@/shared/api/workbench.api";
import { notificationsApi } from "@/shared/api/notifications.api";
import { poolsApi } from "@/shared/api/pools.api";
import "@/shared/state/referenceDataEvents";

function apiInstance() {
  return (axios as any).__instances[0];
}

describe("GET 缓存层（并发去重 + SWR + 写失效）", () => {
  beforeEach(() => {
    clearApiCache();
    localStorage.removeItem("hj.dev-user");
    (axios as any).__resetCalls();
  });

  it("每次报表导出都请求后端，不缓存或合并导出动作", async () => {
    const params = { from: "2026-10-01", to: "2026-10-31", mine: true };
    const first = await reportsApi.exportCsv("commission", params);
    const second = await reportsApi.exportCsv("commission", params);
    const [third, fourth] = await Promise.all([
      reportsApi.exportCsv("commission", params),
      reportsApi.exportCsv("commission", params),
    ]);

    expect([first, second, third, fourth]).toEqual(["NET-1", "NET-2", "NET-3", "NET-4"]);
    expect((axios as any).__getCallCount()).toBe(4);
  });

  it("文件下载不缓存也不合并，避免过期文件和 Blob 累积", async () => {
    const api = apiInstance();
    const download = () => api.request({ method: "get", url: "/cashflows/export.csv", responseType: "blob" });
    const first = await download();
    const second = await download();
    const [third, fourth] = await Promise.all([download(), download()]);
    expect([first.data, second.data, third.data, fourth.data]).toEqual(["NET-1", "NET-2", "NET-3", "NET-4"]);
  });

  it("资金余额每次读取等待最新结果，同时合并并发读取", async () => {
    const first = await poolsApi.balances();
    expect(await poolsApi.balances()).not.toBe(first);
    const [third, fourth] = await Promise.all([poolsApi.balances(), poolsApi.balances()]);
    expect(third).toBe(fourth);
    const single = await poolsApi.balance(1);
    expect(await poolsApi.balance(1)).not.toBe(single);
    expect((axios as any).__getCallCount()).toBe(5);
  });

  it("重新读取经营报表和通知摘要时等待最新结果", async () => {
    const params = { from: "2026-10-01", to: "2026-10-31" };
    const reports = [
      () => reportsApi.monthlyPnl(params),
      () => reportsApi.commission(params),
      () => reportsApi.businessPnl(params),
      () => reportsApi.dataCenter(params),
      () => reportsApi.orderProfit(params),
    ];
    for (const read of reports) {
      const first = await read();
      expect(await read()).not.toBe(first);
    }
    const summary = await notificationsApi.profitDetails([1]);
    expect(await notificationsApi.profitDetails([1])).not.toBe(summary);
    const firstWorkbench = await workbenchApi.summary(params);
    expect(await workbenchApi.summary(params)).not.toBe(firstWorkbench);
    const [firstConcurrent, secondConcurrent] = await Promise.all([workbenchApi.summary(params), workbenchApi.summary(params)]);
    expect(firstConcurrent).toBe(secondConcurrent);
    expect((axios as any).__getCallCount()).toBe(15);
  });

  it("切换操作用户后不会复用上一用户的缓存", async () => {
    const api = apiInstance();
    setDevUser("admin");
    const first = await api.request({ method: "get", url: "/orders" });
    setDevUser("viewer");
    const second = await api.request({ method: "get", url: "/orders" });
    expect(second.data).not.toBe(first.data);
    expect((axios as any).__getCallCount()).toBe(2);
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
    expect((axios as any).__getCallCount()).toBe(1);
  });

  it("大量不同筛选不会让普通 GET 缓存无限增长", async () => {
    const api = apiInstance();
    const oldest = await api.request({ method: "get", url: "/bounded-cache", params: { page: 0 } });
    for (let page = 1; page <= 256; page += 1) {
      await api.request({ method: "get", url: "/bounded-cache", params: { page } });
    }
    const newest = await api.request({ method: "get", url: "/bounded-cache", params: { page: 256 } });
    expect(newest.data).toBe("NET-257");
    const reloadedOldest = await api.request({ method: "get", url: "/bounded-cache", params: { page: 0 } });
    expect(reloadedOldest.data).not.toBe(oldest.data);
    expect((axios as any).__getCallCount()).toBe(258);
  });

  it("强制刷新后的缓存被淘汰时，较早请求仍不能回填旧数据", async () => {
    const api = apiInstance();
    const transport = (axios as any).__instances[1];
    let finishOld!: (value: unknown) => void;
    transport.request.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const old = api.request({ method: "get", url: "/evicted-refresh" });
    await Promise.resolve();
    const fresh = await api.request({ method: "get", url: "/evicted-refresh", refreshCache: true });
    for (let page = 0; page < 256; page += 1) {
      await api.request({ method: "get", url: "/evicted-other", params: { page } });
    }
    finishOld({ data: "OLD", status: 200, headers: {}, config: { method: "GET" } });
    await old;
    const afterEviction = await api.request({ method: "get", url: "/evicted-refresh" });
    expect(afterEviction.data).not.toBe("OLD");
    expect(afterEviction.data).not.toBe(fresh.data);
  });

  it("要求最新数据时只刷新目标接口，并合并并发刷新请求", async () => {
    const api = apiInstance();
    const oldEmployees = await api.request({ method: "get", url: "/users/options" });
    const orders = await api.request({ method: "get", url: "/orders" });
    const [first, second] = await Promise.all([
      api.request({ method: "get", url: "/users/options", refreshCache: true }),
      api.request({ method: "get", url: "/users/options", refreshCache: true }),
    ]);
    expect(first.data).not.toBe(oldEmployees.data);
    expect(second.data).toBe(first.data);
    expect((await api.request({ method: "get", url: "/orders" })).data).toBe(orders.data);
    expect((axios as any).__getCallCount()).toBe(3);
  });

  it("刷新带筛选参数的选项时，不影响同接口的其他筛选缓存", async () => {
    const api = apiInstance();
    const active = { include_inactive: false };
    const all = { include_inactive: true };
    const first = await api.request({ method: "get", url: "/game-types", params: active });
    const other = await api.request({ method: "get", url: "/game-types", params: all });
    const refreshed = await api.request({ method: "get", url: "/game-types", params: active, refreshCache: true });
    expect(refreshed.data).not.toBe(first.data);
    expect((await api.request({ method: "get", url: "/game-types", params: all })).data).toBe(other.data);
    expect((axios as any).__getCallCount()).toBe(3);
  });

  it("强制刷新时，较早的进行中请求不能覆盖新缓存", async () => {
    const api = apiInstance();
    const transport = (axios as any).__instances[1];
    let finishOld!: (value: unknown) => void;
    transport.request.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const old = api.request({ method: "get", url: "/users/options" });
    await Promise.resolve();
    const fresh = api.request({ method: "get", url: "/users/options", refreshCache: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      expect(transport.request).toHaveBeenCalledTimes(2);
      const newest = await fresh;
      finishOld({ data: "OLD", status: 200, headers: {}, config: { method: "GET" } });
      await old;
      expect((await api.request({ method: "get", url: "/users/options" })).data).toBe(newest.data);
    } finally {
      finishOld({ data: "OLD", status: 200, headers: {}, config: { method: "GET" } });
      await Promise.all([old, fresh]);
    }
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

  it("其他标签页变更基础资料后，本页清除旧 GET 缓存", async () => {
    const api = apiInstance();
    const first = await api.request({ method: "get", url: "/users/options" });
    window.dispatchEvent(new StorageEvent("storage", {
      key: "hj.reference-data-changed",
      newValue: JSON.stringify({ resource: "employees", id: "another-tab" }),
    }));
    const refreshed = await api.request({ method: "get", url: "/users/options" });
    expect(refreshed.data).not.toBe(first.data);
    expect((axios as any).__getCallCount()).toBe(2);
  });

  it("写入后旧的进行中读取不会重新填充缓存", async () => {
    const api = apiInstance();
    const transport = (axios as any).__instances[1];
    let finish!: (value: unknown) => void;
    transport.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const old = api.request({ method: "get", url: "/orders" });
    await Promise.resolve();
    await api.request({ method: "post", url: "/orders", data: {} });
    const fresh = await api.request({ method: "get", url: "/orders" });
    finish({ data: "OLD", status: 200, headers: {}, config: { method: "GET" } });
    await old;
    const again = await api.request({ method: "get", url: "/orders" });
    expect(again.data).toBe(fresh.data);
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

  it("多处同时读取过期缓存时只触发一次后台刷新", async () => {
    const api = apiInstance();
    const nowSpy = vi.spyOn(Date, "now");
    let fake = Date.now();
    nowSpy.mockImplementation(() => fake);
    try {
      await api.request({ method: "get", url: "/orders" });
      fake += 10_000;
      const [a, b] = await Promise.all([
        api.request({ method: "get", url: "/orders" }),
        api.request({ method: "get", url: "/orders" }),
      ]);
      expect(a.data).toBe("NET-1");
      expect(b.data).toBe("NET-1");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((axios as any).__getCallCount()).toBe(2);
    } finally { nowSpy.mockRestore(); }
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
