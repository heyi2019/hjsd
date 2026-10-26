import { test, expect, type Page, type Locator } from "@playwright/test";
import { navItem } from "./support/api-stub";

/**
 * 资金 / 返点 / 分期 UI 主写路径端到端联测（真实浏览器 + 真实后端）。
 *
 * 与 business-write.spec.ts（request fixture 直连 API）互补：本文件验证
 * 「用户在前端页面真实点击 → 填表 → 提交 → 页面反馈」这条 UI 主干，提升联调保真度。
 * 不拦截后端，走真实 E2E 库（8124 独立库，由 playwright webServer 自动重建）。
 *
 * antd Select 交互范式（本仓库实测可靠，区别于 getByRole('option')）：
 *  - antd 把下拉渲染在 body 下的 portal（.ant-select-dropdown），选项 class 为
 *    .ant-select-item-option，文本在 .ant-select-item-option-content。
 *  - getByRole('option', { name: /xxx/ }) 在本仓库 antd 版本下对中文选项不稳定（选项已
 *    可见却定位超时）。改用 `.ant-select-dropdown:not(.ant-select-dropdown-hidden).last()
 *    .ant-select-item-option`（hasText 子串）精确点击「刚打开的那个」可见下拉里的目标项；
 *    并对长列表（虚拟滚动）循环滚到底直到目标项渲染可见。
 *  - 打开 Select：定位含 label 文本的 .ant-form-item 内的 .ant-select-selector 点击。
 *    antd Form.Item label 默认带冒号（"资金池："），故 label 用子串匹配。
 *  - MoneyInput / Input：就是 antd Input，`dialog.getByLabel('xxx').fill()` 直填
 *    （getByLabel 对带冒号/必填星号的 label 做子串匹配）。
 *  - Modal：role=dialog；提交按钮用 `getByRole('button', { name })`。
 *  - 断言以 message 文案为主（比表格分页断言更稳）。
 *  - 每个用例挂 pageerror 断言，捕获「未崩溃但抛错」类隐患。
 */

const API_BASE = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8124/api/v1";
const ADMIN = { "X-Dev-User": "admin" };

/**
 * 按表单项的**标签**精确定位（而非 hasText 整项匹配），避免 help 文案含同名子串时
 * 误命中相邻字段。典型坑：资金性质 与 核算属性（help="可选范围由资金性质决定..."）——
 * 若用整项 hasText 会同时命中两项触发 strict violation；按 label 匹配只命中「资金性质」本身。
 */
function formItemByLabel(dialog: Locator, label: string): Locator {
  // 按表单项的**标签**精确定位（而非整项 hasText），避免 help 文案含同名子串时误命中相邻字段。
  // 例：资金性质 与 核算属性（help="可选范围由资金性质决定..."）整项 hasText 会同时命中两项；
  // 仅匹配「label 文本」只命中「资金性质」本身。用 CSS :has() 单次选择器（廉价、点击稳定），
  // 不取 .filter({has})（嵌套 JS 查询在重载下反复求值，导致 .ant-select-selector 迟迟不 actionable）。
  return dialog.locator(`.ant-form-item:has(.ant-form-item-label:has-text(${JSON.stringify(label)}))`);
}

async function openSelect(dialog: Locator, label: string): Promise<void> {
  await formItemByLabel(dialog, label).locator(".ant-select-selector").click();
}

/**
 * 在已打开的对话框内选中下拉项。
 *
 * antd v5 下拉定位范式（本仓库多轮实测收敛出的最稳写法）：
 *  - 下拉渲染在 body 下的 portal，class 为 `.ant-select-dropdown`；打开时**不带**
 *    `ant-select-dropdown-hidden`，关闭动画期间**带**该类。故用
 *    `.ant-select-dropdown:not(.ant-select-dropdown-hidden)` 定位「当前可见下拉」，
 *    并 `toHaveCount(1)` 等待上一个下拉的关闭动画结束（其 `-hidden` 类一旦加上即被
 *    排除），从而唯一确定「刚打开的那个」——规避两类坑：
 *      a) `.last()` 启发式会命中关闭动画中尚未加 `-hidden` 的残留旧下拉；
 *      b) 用 `aria-controls` 的 `#<id>_list` 会因关闭期「同 id 旧节点残留」命中隐藏旧节点。
 *  - antd 对长列表（返点来源订单等）做虚拟滚动，未渲染到视口的选项不在 DOM。故分段
 *    滚动整列（顶→中→底重复多轮），直到目标项渲染并可见再点击（option 为子串匹配：
 *    字符串走子串、正则走 RegExp.test）。
 */
async function pickSelect(
  page: Page,
  dialog: Locator,
  label: string,
  option: RegExp | string,
): Promise<void> {
  await formItemByLabel(dialog, label).locator(".ant-select-selector").click();

  const open = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await expect(open).toHaveCount(1, { timeout: 5000 });
  const dropdown = open.first();

  const opt = dropdown.locator(".ant-select-item-option", { hasText: option });
  const holder = dropdown.locator(".rc-virtual-list-holder").first();
  if ((await holder.count()) > 0) {
    const total = await holder.evaluate((el) => el.scrollHeight).catch(() => 0);
    // 多轮扫描：每轮从顶扫到底，确保虚拟列表把目标行渲染进 DOM 至少一次。
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i <= 20; i++) {
        await holder
          .evaluate((el, top) => {
            el.scrollTop = top;
          }, (i / 20) * total)
          .catch(() => undefined);
        await page.waitForTimeout(50);
        if ((await opt.count()) > 0 && (await opt.first().isVisible())) break;
      }
      if ((await opt.count()) > 0 && (await opt.first().isVisible())) break;
      await holder.evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => undefined);
      await page.waitForTimeout(80);
    }
  }
  await opt.first().click({ timeout: 5000 });
}

test.describe("资金/返点/分期 UI 主写路径", () => {
  test("资金中心·流水：新增独立资金流水", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/");
    await navItem(page, "资金中心").click();
    await page.getByRole("tab", { name: "流水", exact: true }).click();
    await page.getByRole("button", { name: "新增流水" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await pickSelect(page, dialog, "资金池", /投资款荷包/);
    await dialog.getByLabel("发生日期").fill("2026-10-21");
    await pickSelect(page, dialog, "收支方向", "收入");
    await pickSelect(page, dialog, "资金性质", "本方经营");
    await pickSelect(page, dialog, "核算属性", "自营收入");
    await dialog.getByLabel("类别").fill("E2E_UI_FLOW");
    await dialog.getByLabel("金额").fill("10.00");
    await dialog.getByLabel("摘要").fill("E2E 独立流水 UI");
    await dialog.getByRole("button", { name: "提交审核" }).click();

    await expect(page.getByText("独立资金流水已提交，等待审核")).toBeVisible({ timeout: 10000 });
    expect(errors).toEqual([]);
  });

  test("资金中心·总览：资金池划转登记", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/");
    await navItem(page, "资金中心").click(); // 默认总览
    await page.getByRole("button", { name: "资金池划转" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await pickSelect(page, dialog, "转出资金池", /投资款荷包/);
    await pickSelect(page, dialog, "转入资金池", /利润荷包/);
    await dialog.getByLabel("划转金额").fill("1.00");
    await dialog.getByLabel("划转日期").fill("2026-10-21");
    await dialog.getByLabel("说明").fill("E2E 划转 UI");
    await dialog.getByRole("button", { name: "确认划转" }).click();

    await expect(page.getByText("资金池划转已登记")).toBeVisible({ timeout: 10000 });
    expect(errors).toEqual([]);
  });

  test("资金中心·返点：新增返点记录", async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    // 业务规则：买号返点（BUY）只能关联回收（HS）订单。故新建 HS 订单作为来源。
    // HS 订单需绑定 IN_STOCK 的 RECOVERY 账号（与 business-write 夹具一致）。
    const accounts = (await request
      .get(`${API_BASE}/accounts`, { headers: ADMIN })
      .then((r) => r.json())) as Array<{ id: number; status: string; inventory_type?: string }>;
    const account = accounts.find(
      (a) => a.status === "IN_STOCK" && a.inventory_type === "RECOVERY",
    );
    expect(account, "缺少 RECOVERY 测试账号").toBeTruthy();
    const order = await request.post(`${API_BASE}/orders`, {
      headers: ADMIN,
      data: { order_type: "HS", account_id: account.id, trade_date: "2026-10-21" },
    });
    expect(order.status()).toBe(201);
    const orderBody = (await order.json()) as { id: number; order_no: string };
    const orderNo = orderBody.order_no;
    // 业务规则（app/finance/rebates.py:91）：BUY 返点要求来源 HS 订单已登记
    // is_posted=True 的 BUY 事件。故这里补登记一笔 BUY 事件，否则提交会被拒。
    const evt = await request.post(`${API_BASE}/orders/${orderBody.id}/events`, {
      headers: ADMIN,
      data: { event_type: "BUY", amount: "100.00", occurred_on: "2026-10-21" },
    });
    expect(evt.status()).toBe(201);

    await page.goto("/");
    await navItem(page, "资金中心").click();
    await page.getByRole("tab", { name: "返点", exact: true }).click();
    await page.getByRole("button", { name: "新增返点记录" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await pickSelect(page, dialog, "来源订单", orderNo);
    await pickSelect(page, dialog, "返点类型", "买号返点");
    await dialog.getByLabel("返点金额").fill("10.00");
    await dialog.getByLabel("返点比例").fill("5");
    await dialog.getByLabel("返点日期").fill("2026-10-21");
    // antd 该按钮可访问名偶发插入空格（"创 建"），用 \s* 容错。
    await dialog.getByRole("button", { name: /创\s*建/ }).click();

    await expect(page.getByText("返点记录已创建")).toBeVisible({ timeout: 10000 });
    expect(errors).toEqual([]);
  });

  test("业务中心·分期：登记收款", async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    // 预置分期合约：DFQ 订单 + 代分期合约（ADVANCE_PURCHASE）。
    const order = await request.post(`${API_BASE}/orders`, {
      headers: ADMIN,
      data: { order_type: "DFQ", trade_date: "2026-10-21" },
    });
    expect(order.status()).toBe(201);
    const orderId = (await order.json()).id as number;
    const inst = await request.post(`${API_BASE}/installments`, {
      headers: ADMIN,
      data: {
        order_id: orderId,
        contract_type: "ADVANCE_PURCHASE",
        principal: "1200.00",
        down_payment: "0.00",
        periods: 3,
        per_period: "400.00",
        first_due_on: "2026-10-21",
      },
    });
    expect(inst.status()).toBe(201);
    const instNo = (await inst.json()).inst_no as string;

    await page.goto("/");
    await navItem(page, "业务中心").click();
    await page.getByRole("tab", { name: "分期与回款", exact: true }).click();
    // 安装面板默认在「分期出售」子 Tab，切到「代分期」以匹配 ADVANCE_PURCHASE 合约。
    await page.getByRole("tab", { name: "代分期", exact: true }).click();

    const row = page.locator(".ant-table-row", { hasText: instNo }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.getByRole("button", { name: "登记收款" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("本次实收").fill("400.00");
    await dialog.getByLabel("收款日期").fill("2026-10-21");
    await dialog.getByRole("button", { name: "确认收款" }).click();

    await expect(page.getByText("收款已登记")).toBeVisible({ timeout: 10000 });
    expect(errors).toEqual([]);
  });
});
