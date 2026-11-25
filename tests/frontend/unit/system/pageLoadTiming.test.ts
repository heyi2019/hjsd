import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPageLoadTiming, trackPageLoadRequest } from "@/shared/lib/pageLoadTiming";

describe("页面加载计时", () => {
  let root: HTMLElement;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    root = document.createElement("main");
    document.body.append(root);
  });

  afterEach(() => {
    stop?.();
    root.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("等待所有请求和画面更新，再记录页面耗时", async () => {
    stop = startPageLoadTiming("工作台", root);
    const finishFirst = trackPageLoadRequest();
    const finishSecond = trackPageLoadRequest();
    await vi.advanceTimersByTimeAsync(500);
    expect(console.info).not.toHaveBeenCalled();
    finishFirst?.(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(console.info).not.toHaveBeenCalled();
    root.textContent = "数据已显示";
    finishSecond?.(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(console.info).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith(expect.stringMatching(/页面加载计时.*工作台/));
    const logged = String(vi.mocked(console.info).mock.calls[0][0]);
    expect(Number(logged.match(/：([\d.]+) 秒/)?.[1])).toBeGreaterThanOrEqual(1);
  });

  it("切页后旧请求不会让新页面提前结束", async () => {
    startPageLoadTiming("工作台", root);
    const finishOld = trackPageLoadRequest();
    stop = startPageLoadTiming("客户中心", root);
    const finishNew = trackPageLoadRequest();
    finishOld?.(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(console.info).not.toHaveBeenCalled();
    finishNew?.(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(console.info).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith(expect.stringMatching(/客户中心.*1 个请求失败/));
  });

  it("页面一直处于加载中时报告超时，而不是声称加载完成", async () => {
    root.innerHTML = '<section aria-busy="true"></section>';
    stop = startPageLoadTiming("资金中心", root);
    await vi.advanceTimersByTimeAsync(30_100);
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/资金中心.*超过 30 秒仍未稳定/));
  });
});
