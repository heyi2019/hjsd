import { describe, expect, it } from "vitest";
import { createKeyedLatestRequest, createLatestRequest } from "@/shared/hooks/useLatestRequest";

describe("异步请求生命周期", () => {
  it("新请求或主动关闭后，旧请求不再能更新界面", () => {
    const request = createLatestRequest();
    const first = request.start();
    const second = request.start();
    expect(request.isCurrent(first)).toBe(false);
    expect(request.isCurrent(second)).toBe(true);
    expect(request.current()).toBe(second);
    request.invalidate();
    expect(request.isCurrent(second)).toBe(false);
  });

  it("不同操作互不干扰", () => {
    const first = createLatestRequest();
    const second = createLatestRequest();
    const firstToken = first.start();
    const secondToken = second.start();
    first.invalidate();
    expect(first.isCurrent(firstToken)).toBe(false);
    expect(second.isCurrent(secondToken)).toBe(true);
  });

  it("按订单区分请求，刷新一单不会取消其他订单的结果", () => {
    const request = createKeyedLatestRequest<number>();
    const first = request.start(1);
    const other = request.start(2);
    const latest = request.start(1);
    expect(request.isCurrent(1, first)).toBe(false);
    expect(request.isCurrent(1, latest)).toBe(true);
    expect(request.isCurrent(2, other)).toBe(true);
    const snapshot = request.snapshot();
    request.invalidate(2);
    expect(snapshot.get(2)).toBe(other);
    expect(request.isCurrent(2, other)).toBe(false);
    expect(request.isCurrent(1, latest)).toBe(true);
  });
});
