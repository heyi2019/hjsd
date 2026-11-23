import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 真后端「账号密码登录」E2E（联调用例）。
 *
 * 与 smoke / role-switch 不同：本用例**不拦截** `/api/**`、不走 DEV 态
 * X-Dev-User 直通，而是真实打后端（默认 http://127.0.0.1:8123/api），
 * 用联调管理员账号 `admin / 12345678` 实测：
 *   登录 → 拿 JWT → 带 token 访问受保护接口 → 鉴权通过；
 *   错误密码 / 无 token → 401。
 *
 * 前置：后端必须运行在 8123（8000 被 Docker 占用）。可用环境变量覆盖：
 *   ERP_E2E_API_BASE=http://127.0.0.1:8123/api
 */
const API_BASE =
  process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api";

const ADMIN_USER = "admin";
const ADMIN_PASS = "12345678";

test("登录卡片固定深色，控件高度和版本一致", async ({ page }) => {
  await page.goto("/#/workbench");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.locator(".ant-popconfirm").getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByRole("heading", { name: "登录工作台" })).toBeVisible();
  const card = page.locator(".login-card");
  const version = readFileSync(resolve(__dirname, "../../../VERSION"), "utf8").trim();
  await expect(card.getByText(`V${version}`)).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await expect(card).toHaveCSS("background-color", "rgb(22, 34, 54)");
    await expect(card.getByLabel("用户名")).toHaveCSS("height", "36px");
    await expect(card.locator(".ant-input-affix-wrapper")).toHaveCSS("height", "36px");
    await expect(card.getByRole("button", { name: "登录" })).toHaveCSS("height", "36px");
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("首次改密与管理员重置后旧会话失效", async ({ request }) => {
  const username = `e2e_auth_${Date.now()}`;
  const created = await request.post(`${API_BASE}/users`, { headers: { "X-Dev-User": "admin" }, data: { username, display_name: "E2E 会话测试", password: "initial-pass-123", role: "OPERATOR" } });
  expect(created.status(), await created.text()).toBe(201);
  const user = await created.json();
  const loggedIn = await request.post(`${API_BASE}/auth/login`, { data: { username, password: "initial-pass-123" } });
  expect(loggedIn.status()).toBe(200);
  const oldToken = (await loggedIn.json()).access_token;
  const oldHeaders = { Authorization: `Bearer ${oldToken}` };
  expect((await request.get(`${API_BASE}/orders`, { headers: oldHeaders })).status()).toBe(403);
  const changed = await request.post(`${API_BASE}/auth/change-password`, { headers: oldHeaders, data: { old_password: "initial-pass-123", new_password: "updated-pass-123" } });
  expect(changed.status(), await changed.text()).toBe(200);
  const newHeaders = { Authorization: `Bearer ${(await changed.json()).access_token}` };
  expect((await request.get(`${API_BASE}/orders`, { headers: newHeaders })).status()).toBe(200);
  expect((await request.get(`${API_BASE}/auth/me`, { headers: oldHeaders })).status()).toBe(401);
  const reset = await request.post(`${API_BASE}/users/${user.id}/reset-password`, { headers: { "X-Dev-User": "admin" }, data: { password: "reset-pass-123" } });
  expect(reset.status()).toBe(200);
  expect((await request.get(`${API_BASE}/auth/me`, { headers: newHeaders })).status()).toBe(401);
});

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
