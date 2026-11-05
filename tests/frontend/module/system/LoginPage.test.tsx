import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { LoginPage } from "@/auth/LoginPage";

import * as client from "@/shared/api/client";
vi.mock("@/shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/client")>()),
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  login: vi.fn(),
  logout: vi.fn(),
  setDevUser: vi.fn(),
  changePassword: vi.fn(),
  checkBackendHealth: vi.fn(),
  // 免密登录相关函数必须显式声明为 spy：模块 mock 是「原样展开 + 覆盖」，
  // 不列出来的话拿到的是真实实现，mockResolvedValue 会直接报 not a function。
  fetchLoginMethods: vi.fn(),
  requestWechatAuthorize: vi.fn(),
  wechatLogin: vi.fn(),
  sendPhoneLoginCode: vi.fn(),
  phoneLogin: vi.fn(),
  sendWechatBindCode: vi.fn(),
  confirmWechatBind: vi.fn(),
  persistAccessToken: vi.fn(),
}));

describe("LoginPage：后端前置检查", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认给一个「只有账号密码」的响应，避免本组用例依赖某个未打桩的返回值。
    vi.mocked(client.fetchLoginMethods).mockResolvedValue({
      password: { enabled: true },
      phone_code: { enabled: false, dev_code_visible: false },
      wechat: { enabled: false, configured: false, provider: "disabled", verify_mode: "sms" as const, reason: null },
    });
  });

  it("后端不可达时显示连接提示，而不是等待登录后才报 500", async () => {
    vi.mocked(client.checkBackendHealth).mockRejectedValueOnce(new Error("后端不可达"));

    renderLight(<LoginPage />, { user: "admin" });

    expect(await screen.findByRole("alert")).toHaveTextContent("后端不可达");
  });

  it("DEV 态 admin 留空密码可以直接登录", async () => {
    vi.mocked(client.checkBackendHealth).mockResolvedValueOnce(undefined);
    const ui = userEvent.setup({ pointerEventsCheck: 0 });
    renderLight(<LoginPage />);

    await ui.type(screen.getByLabelText("用户名"), "admin");
    await ui.click(screen.getByRole("button", { name: "登录" }));

    expect(client.login).not.toHaveBeenCalled();
    expect(screen.queryByText("请输入密码")).toBeNull();
  });
});

describe("LoginPage：免密登录入口按后端配置点亮", () => {
  const disabledMethods = {
    password: { enabled: true },
    phone_code: { enabled: false, dev_code_visible: false },
    wechat: { enabled: false, configured: false, provider: "disabled", verify_mode: "sms" as const, reason: "微信登录未启用" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.checkBackendHealth).mockResolvedValue(undefined);
  });

  it("通道未启用时不出现手机号切换与微信按钮（避免点了必然失败）", async () => {
    vi.mocked(client.fetchLoginMethods).mockResolvedValue(disabledMethods);

    renderLight(<LoginPage />);
    await screen.findByLabelText("用户名");

    expect(screen.queryByText("手机号验证码")).toBeNull();
    expect(screen.queryByRole("button", { name: "微信登录" })).toBeNull();
    // 系统不开放注册：登录页不得出现注册入口。
    expect(screen.queryByText(/注册/)).toBeNull();
  });

  it("通道启用后出现手机号验证码切换与微信扫码入口", async () => {
    vi.mocked(client.fetchLoginMethods).mockResolvedValue({
      password: { enabled: true },
      phone_code: { enabled: true, dev_code_visible: true },
      wechat: { enabled: true, configured: true, provider: "mock", verify_mode: "sms" as const, reason: null },
    });

    renderLight(<LoginPage />);

    expect(await screen.findByText("手机号验证码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "微信登录" })).toBeInTheDocument();
    expect(screen.getByText("首次登录需绑定后台已配置的手机号")).toBeInTheDocument();
  });
});
