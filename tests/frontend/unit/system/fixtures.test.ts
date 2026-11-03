import { beforeEach, describe, expect, it } from "vitest";
import { DEV_USER_KEY } from "@/shared/api/client";
import { resetTestBrowserState } from "@fixtures/fixtures";

describe("测试夹具隔离", () => {
  beforeEach(() => {
    resetTestBrowserState();
  });

  it("清理角色、会话和页面级主题状态", () => {
    localStorage.setItem(DEV_USER_KEY, "admin");
    sessionStorage.setItem("fixture-session", "stale");
    document.documentElement.dataset.theme = "dark";

    resetTestBrowserState();

    expect(localStorage.getItem(DEV_USER_KEY)).toBeNull();
    expect(sessionStorage.getItem("fixture-session")).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
