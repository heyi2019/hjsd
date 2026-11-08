import { test, expect } from "@playwright/test";

/**
 * 真后端「写路径」CRUD 联测（前后端闭环）。
 *
 * 不走页面 stub，直连真实后端（默认 127.0.0.1:8123），使用开发态 admin 身份实测：
 *   创建客户 → 落库后出现在列表 → 改名并回读 → 软删除（后端无硬 DELETE，置 DISABLED）。
 * 覆盖 frontend `customersApi` 的 create / list / patch / status 写路径契约。
 *
 * 自清理：后端无硬 DELETE 端点，故以 `DISABLED` 状态收尾；用例开始时也会先把残留的
 * `联测_CRUD_` 测试客户置 DISABLED，避免多次运行堆积活跃测试数据。
 *
 * 前置：后端运行在 8123（playwright webServer 会自动拉起）。
 */
const API_BASE =
  process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
const TEST_PREFIX = "联测_CRUD_";
const AUTH_HEADERS = { "X-Dev-User": "admin" };

test.describe("real-backend CRUD round-trip", () => {
  test("创建→读取→更新→软删除（写路径闭环，自清理）", async ({
    request,
  }) => {
    const auth = AUTH_HEADERS;

    // 0) 清理残留：把已有的 联测_CRUD_ 测试客户置 DISABLED
    // GET /customers 返回分页信封 { items, total }（PageOut），不再返回裸数组。
    const pre = (await (
      await request.get(`${API_BASE}/customers`, { headers: auth })
    ).json()) as { items: Array<{ id: number; display_name: string }> };
    for (const c of pre.items) {
      if (typeof c.display_name === "string" && c.display_name.startsWith(TEST_PREFIX)) {
        await request.patch(`${API_BASE}/customers/${c.id}/status`, {
          headers: auth,
          data: { status: "DISABLED" },
        });
      }
    }

    // 1) Create（响应嵌套在 customer 字段下）
    const created = await request.post(`${API_BASE}/customers`, {
      headers: auth,
      data: { display_name: `${TEST_PREFIX}临时客户` },
    });
    expect(created.status()).toBe(201);
    const createdBody = await created.json();
    const id = createdBody.customer.id as number;
    expect(createdBody.customer.status).toBe("ACTIVE");

    // 2) Read：新客户已落库并出现在列表
    const list = await request.get(`${API_BASE}/customers`, { headers: auth });
    const customers = (await list.json()) as {
      items: Array<{ id: number; display_name: string }>;
    };
    expect(
      customers.items.some(
        (c: { id: number; display_name: string }) =>
          c.id === id && c.display_name.startsWith(TEST_PREFIX),
      ),
    ).toBe(true);

    // 3) Update：改名并断言回读
    const NEW_NAME = `${TEST_PREFIX}临时客户_改`;
    const patched = await request.patch(`${API_BASE}/customers/${id}`, {
      headers: auth,
      data: { display_name: NEW_NAME },
    });
    expect(patched.status()).toBe(200);
    expect((await patched.json()).display_name).toBe(NEW_NAME);

    const reread = await request.get(`${API_BASE}/customers/${id}`, {
      headers: auth,
    });
    expect((await reread.json()).display_name).toBe(NEW_NAME);

    // 4) 软删除 + 复位名称（后端无硬 DELETE，置 DISABLED 收尾）
    await request.patch(`${API_BASE}/customers/${id}`, {
      headers: auth,
      data: { display_name: `${TEST_PREFIX}临时客户` },
    });
    const disabled = await request.patch(
      `${API_BASE}/customers/${id}/status`,
      { headers: auth, data: { status: "DISABLED" } },
    );
    expect(disabled.status()).toBe(200);
    expect((await disabled.json()).status).toBe("DISABLED");
  });
});
