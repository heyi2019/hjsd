import { test, expect } from "@playwright/test";

/**
 * 真后端「账号密码登录」E2E（联调用例）。
 *
 * 与 smoke / role-switch 不同：本用例**不拦截** `/api/v1/**`、不走 DEV 态
 * X-Dev-User 直通，而是真实打后端（默认 http://127.0.0.1:8123/api/v1），
 * 用联调管理员账号 `admin / 12345678` 实测：
 *   登录 → 拿 JWT → 带 token 访问受保护接口 → 鉴权通过；
 *   错误密码 / 无 token → 401。
 *
 * 前置：后端必须运行在 8123（8000 被 Docker 占用）。可用环境变量覆盖：
 *   ERP_E2E_API_BASE=http://127.0.0.1:8123/api/v1
 */
const API_BASE =
  process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";

const ADMIN_USER = "admin";
const ADMIN_PASS = "12345678";

test.describe("real-backend account login", () => {
  test("正确密码登录 admin/12345678 返回有效 JWT 且角色为 ADMIN", async ({
    request,
  }) => {
    const res = await request.post(`${API_BASE}/auth/login`, {
      data: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.token_type).toBe("bearer");
    expect(body.user.username).toBe(ADMIN_USER);
    expect(body.user.role).toBe("ADMIN");
    expect(body.user.owner_scope).toBe("ALL");
    expect(body.user.is_active).toBe(true);
  });

  test("带 token 访问 /auth/me 返回管理员资料", async ({ request }) => {
    const login = await request.post(`${API_BASE}/auth/login`, {
      data: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    const { access_token: token } = await login.json();

    const me = await request.get(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status()).toBe(200);
    const meBody = await me.json();
    expect(meBody.username).toBe(ADMIN_USER);
    expect(meBody.role).toBe("ADMIN");
  });

  test("带 token 访问管理员专用接口 /users 返回 200", async ({
    request,
  }) => {
    const login = await request.post(`${API_BASE}/auth/login`, {
      data: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    const { access_token: token } = await login.json();

    const users = await request.get(`${API_BASE}/users`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(users.status()).toBe(200);
    const list = await users.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((u: { username: string }) => u.username === ADMIN_USER)).toBe(
      true,
    );
  });

  test("错误密码登录返回 401", async ({ request }) => {
    const res = await request.post(`${API_BASE}/auth/login`, {
      data: { username: ADMIN_USER, password: "wrong-password" },
    });
    expect(res.status()).toBe(401);
  });

  test("无 token 访问受保护接口 /users 返回 401", async ({ request }) => {
    const res = await request.get(`${API_BASE}/users`);
    expect(res.status()).toBe(401);
  });
});
