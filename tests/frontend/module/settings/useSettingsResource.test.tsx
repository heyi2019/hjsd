import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingsResource } from "@/shared/state/useSettingsResource";

describe("useSettingsResource", () => {
  it("加载设置资源并在成功后提供数据", async () => {
    const load = vi.fn().mockResolvedValue(["teams"]);

    const { result } = renderHook(() => useSettingsResource(load));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual(["teams"]));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("加载失败后可以通过 reload 重试", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("settings unavailable"))
      .mockResolvedValueOnce(["recovered"]);

    const { result } = renderHook(() => useSettingsResource(load));

    await waitFor(() => expect(result.current.error?.message).toBe("Error: settings unavailable"));
    expect(result.current.data).toBeNull();

    await result.current.reload();

    await waitFor(() => expect(result.current.data).toEqual(["recovered"]));
    expect(result.current.error).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
