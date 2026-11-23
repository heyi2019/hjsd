import { test, expect, type Page, type Locator } from "@playwright/test";
import { navItem } from "../support/api-stub";

/**
 * 资金 / 返点 / 分期 UI 主写路径端到端联测（真实浏览器 + 真实后端）。
 *
 * 与 business-write.spec.ts（request fixture 直连 API）互补：本文件验证
 * 「用户在前端页面真实点击 → 填表 → 提交 → 页面反馈」这条 UI 主干，提升联调保真度。
 * 不拦截后端，走真实 E2E 库（8124 独立库，启动时按需补充测试数据）。
 *
 * antd Select 交互范式（本仓库实测可靠，区别于 getByRole('option')）：
 *  - antd 把下拉渲染在 body 下的 portal（.ant-select-dropdown），选项 class 为
 *    .ant-select-item-option，文本在 .ant-select-item-option-content。
 *  - getByRole('option', { name: /xxx/ }) 在本仓库 antd 版本下对中文选项不稳定（选项已
 *    可见却定位超时）。改用 `.ant-select-dropdown:not(.ant-select-dropdown-hidden).last()
 *    .ant-select-item-option`（hasText 子串）精确点击「刚打开的那个」可见下拉里的目标项；
 *    并对长列表（虚拟滚动）循环滚到底直到目标项渲染可见。
 *  - 打开 Select：定位含 label 文本的 .ant-form-item 内的 .ant-select-selector 点击。
 *    antd Form.Item label 默认带冒号（"资金账户："），故 label 用子串匹配。
 *  - MoneyInput / Input：就是 antd Input，`dialog.getByLabel('xxx').fill()` 直填
 *    （getByLabel 对带冒号/必填星号的 label 做子串匹配）。
 *  - Modal：role=dialog；提交按钮用 `getByRole('button', { name })`。
 *  - 断言以 message 文案为主（比表格分页断言更稳）。
 *  - 每个用例挂 pageerror 断言，捕获「未崩溃但抛错」类隐患。
 */

const API_BASE = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8124/api";
const ADMIN = { "X-Dev-User": "admin" };

/**
 * 按表单项的**标签**精确定位（而非 hasText 整项匹配），避免 help 文案含同名子串时
 * 误命中相邻字段。典型坑：核算属性 的 help 文案含业务名词子串——
 * 若用整项 hasText 会同时命中多个字段触发 strict violation；按 label 匹配只命中目标本身。
 */
function formItemByLabel(dialog: Locator, label: string): Locator {
  // 按表单项的**标签**精确定位（而非整项 hasText），避免 help 文案含同名子串时误命中相邻字段。
  // 例：核算属性 的 help 文案含业务名词子串，整项 hasText 会同时命中多项；
  // 仅匹配「label 文本」只命中目标本身。用 CSS :has() 单次选择器（廉价、点击稳定），
  // 不取 .filter({has})（嵌套 JS 查询在重载下反复求值，导致 .ant-select-selector 迟迟不 actionable）。
  return dialog.locator(`.ant-form-item:has(.ant-form-item-label:has-text(${JSON.stringify(label)}))`);
}

async function openSelect(dialog: Locator, label: string): Promise<void> {
  await formItemByLabel(dialog, label).locator(".ant-select-selector").click();
}

/** 按表单项标签定位其首个 input 并填入值（覆盖金额/比例/日期等受控输入）。
 *  比 getByLabel 更稳：直接走 form-item 容器 → input，不受 antd 冒号/后缀/多 Modal 影响。
 *  注：弹窗入场动画（transform: scale）或紧随下拉关闭的回流瞬间，受控 input 可能被量到 0 宽，
 *  常规 fill 会因「不可见」被拒；用 force 跳过可见性校验（值仍经 onChange 进入表单状态）。
 *  布局稳定后输入框宽度正常，故这是对瞬态时序的兜底，而非掩盖布局缺陷。 */
async function fillByLabel(dialog: Locator, label: string, value: string): Promise<void> {
  const control = formItemByLabel(dialog, label).locator("input").first();
  await control.fill(value, { force: true });
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
async function pickOptionInDropdown(
  page: Page,
  dropdown: Locator,
  option: RegExp | string,
): Promise<void> {
  const opt = dropdown.locator(".ant-select-item-option", { hasText: option });
  // 虚拟列表（长选项集）：小步增量下滚，直到目标项渲染并可见。
  const holder = dropdown.locator(".rc-virtual-list-holder").first();
  if ((await holder.count()) > 0) {
    for (let i = 0; i < 40; i++) {
      if ((await opt.first().isVisible().catch(() => false))) break;
      await holder
        .evaluate((el) => {
          el.scrollTop += Math.max(el.clientHeight * 0.9, 40);
        })
        .catch(() => undefined);
      await page.waitForTimeout(25);
    }
  }
  await expect(opt.first()).toBeVisible({ timeout: 5000 });
  await opt.first().click({ timeout: 5000 });
}

async function pickSelect(
  page: Page,
  dialog: Locator,
  label: string,
  option: RegExp | string,
): Promise<void> {
  const item = formItemByLabel(dialog, label);
  const selector = item.locator(".ant-select-selector");
  const select = item.locator(".ant-select");

  // 关掉任何残留的下拉（若有）：仅在确实存在可见下拉时才按 Esc——避免误关 Modal。
  // antd 单选下拉打开时 Esc 会 stopPropagation，不会冒泡关掉外层 Modal。
  if (
    (await page
      .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
      .count()) > 0
  ) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(150);
  }

  // 打开本字段下拉：必须点 .ant-select-selector（实际可点区域），点 .ant-select 外层
  // 会被 label/遮挡层拦截导致 action 无限等待。
  await selector.click();
  const dropdown = page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .last();
  await expect(dropdown).toBeVisible({ timeout: 5000 });

  await pickOptionInDropdown(page, dropdown, option);

  // 关闭断言：antd 单选选择后应自动收起。若仍打开（点击被吞/动画竞态），按 Esc 兜底关闭
  // （此刻下拉确定打开，Esc 安全且 stopPropagation，不会关 Modal）。
  let closed = false;
  try {
    await expect(dropdown).toBeHidden({ timeout: 4000 });
    closed = true;
  } catch {
    closed = false;
  }
  if (!closed) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await expect(dropdown).toBeHidden({ timeout: 4000 }).catch(() => undefined);
  }
  await page.waitForTimeout(120);

  // 校验值确实写入（不仅下拉关闭，还要选中项文本命中目标）——否则一次点击被吞也不易被察觉。
  const selText = await select
    .locator(".ant-select-selection-item")
    .first()
    .innerText()
    .catch(() => "");
  const matched =
    typeof option === "string" ? selText.includes(option) : option.test(selText);
  if (!matched) {
    if (
      (await page
        .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
        .count()) > 0
    ) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(150);
    }
    await selector.click();
    const dd2 = page
      .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
      .last();
    await expect(dd2).toBeVisible({ timeout: 5000 });
    await pickOptionInDropdown(page, dd2, option);
    try {
      await expect(dd2).toBeHidden({ timeout: 4000 });
    } catch {
      await page.keyboard.press("Escape").catch(() => undefined);
      await expect(dd2).toBeHidden({ timeout: 4000 }).catch(() => undefined);
    }
    await page.waitForTimeout(120);
  }
}

test.describe("资金/返点/分期 UI 主写路径", () => {
  test("资金中心·工作室收入登记、展示并保留冲销凭证", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/");
    await navItem(page, "资金中心").click();
    await page.getByRole("tab", { name: "工作室运营" }).click();
    await page.getByRole("button", { name: "记一笔" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: /资金(池|账户)/ }).click();
    await page.getByTitle("投资款荷包", { exact: true }).last().click();
    await dialog.locator(".ant-segmented-item").filter({ hasText: "收入" }).click();
    await dialog.getByRole("combobox", { name: /科目/ }).click();
    await page.getByTitle("货款", { exact: true }).last().click();
    await dialog.getByLabel("金额").fill("10.00");
    const note = `E2E 工作室收入 ${Date.now()}`;
    await dialog.getByLabel("备注").fill(note);
    const posted = page.waitForResponse((r) => r.url().endsWith("/cashflows") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "登记入账" }).click();
    const response = await posted;
    expect(response.status()).toBe(201);
    const flow = await response.json();
    expect(flow.ledger_type).toBe("STUDIO");
    expect(flow.direction).toBe("IN");

    await expect(page.getByText("收入已登记")).toBeVisible({ timeout: 10000 });
    await page.getByRole("tab", { name: "资金明细" }).click();
    await page.getByRole("button", { name: "全部" }).click();
    await page.getByRole("searchbox", { name: "流水搜索" }).fill(note);
    await page.getByRole("searchbox", { name: "流水搜索" }).press("Enter");
    await expect(page.getByRole("row").filter({ hasText: flow.flow_no })).toBeVisible();

    await page.getByRole("tab", { name: "工作室运营" }).click();
    const originalRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: flow.flow_no, exact: true }) });
    await expect(originalRow).toBeVisible();
    await originalRow.getByRole("button", { name: "冲销" }).click();
    const reverseDialog = page.getByRole("dialog", { name: "冲销工作室收支" });
    await reverseDialog.getByLabel("冲销原因").fill("端到端验证冲销");
    const reversed = page.waitForResponse((r) => r.url().endsWith(`/cashflows/${flow.id}/reverse`) && r.request().method() === "POST");
    await reverseDialog.getByRole("button", { name: "确认冲销" }).click();
    const reversalResponse = await reversed;
    expect(reversalResponse.status()).toBe(200);
    const reversal = await reversalResponse.json();
    expect(reversal.ledger_type).toBe("STUDIO");
    expect(reversal.direction).toBe("OUT");
    expect(reversal.source_id).toBe(flow.flow_no);
    await expect(page.getByText("工作室收支已冲销")).toBeVisible();
    await expect(originalRow).toBeVisible();
    await expect(originalRow.getByRole("button", { name: "冲销" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("资金中心·总览：资金账户划转登记", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/");
    await navItem(page, "资金中心").click(); // 默认总览
    await page.getByRole("button", { name: "资金账户划转" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await pickSelect(page, dialog, "转出资金账户", /投资款荷包/);
    await pickSelect(page, dialog, "转入资金账户", /利润荷包/);
    await dialog.getByLabel("划转金额").fill("1.00");
    await dialog.getByLabel("划转日期").fill("2026-10-21");
    await dialog.getByLabel("说明").fill("E2E 划转 UI");
    await dialog.getByRole("button", { name: "确认划转" }).click();

    await expect(page.getByText("资金账户划转已登记")).toBeVisible({ timeout: 10000 });
    expect(errors).toEqual([]);
  });

  test("押金登记及部分释放逐笔保留流水和操作人", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await navItem(page, "资金中心").click();
    await page.getByRole("tab", { name: "押金" }).click();
    await page.getByRole("button", { name: "新增占用" }).click();
    const depositDialog = page.getByRole("dialog", { name: "新增押金占用" });
    await depositDialog.getByRole("combobox", { name: /资金(池|账户)/ }).click();
    await page.getByTitle("投资款荷包", { exact: true }).last().click();
    await depositDialog.getByLabel("占用金额").fill("37.00");
    const created = page.waitForResponse((r) => r.url().endsWith("/deposits") && r.request().method() === "POST");
    await depositDialog.getByRole("button", { name: "提交" }).click();
    const createResponse = await created;
    expect(createResponse.status()).toBe(201);
    const deposit = await createResponse.json();
    const hold = deposit.action_history.find((action: { action: string }) => action.action === "HOLD");
    expect(hold.operator_user_ids.length).toBeGreaterThan(0);

    const row = page.getByRole("row").filter({ hasText: hold.flow_no });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "释放" }).click();
    const releaseDialog = page.getByRole("dialog", { name: "押金释放" });
    await releaseDialog.getByLabel("释放金额").fill("12.00");
    const released = page.waitForResponse((r) => r.url().endsWith(`/deposits/${deposit.id}/returns`) && r.request().method() === "POST");
    await releaseDialog.getByRole("button", { name: "确认释放" }).click();
    const releaseResponse = await released;
    expect(releaseResponse.status()).toBe(200);
    const updated = await releaseResponse.json();
    expect(updated.returned_amount).toBe("12.00");
    expect(updated.remaining_amount).toBe("25.00");
    const release = updated.action_history.find((action: { action: string }) => action.action === "RETURN");
    expect(release.operator_user_ids.length).toBeGreaterThan(0);
    await expect(row).toContainText(release.flow_no);
    expect(errors).toEqual([]);
  });

  test("订单台账登记返点并生成收入流水", async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    // 买号返点关联 HS 订单；用唯一账号快照建单，避免依赖共享库存夹具。
    const order = await request.post(`${API_BASE}/orders`, {
      headers: ADMIN,
      data: { order_type: "HS", account_snapshot: { game_account: `e2e-rebate-${Date.now()}`, game_type: "王者荣耀" }, trade_date: "2026-10-21", form_extra: { business_responsible_ids: [1] } },
    });
    expect(order.status(), await order.text()).toBe(201);
    const orderBody = (await order.json()) as { id: number; order_no: string };
    const orderNo = orderBody.order_no;
    const evt = await request.post(`${API_BASE}/orders/${orderBody.id}/events`, {
      headers: ADMIN,
      data: { event_type: "BUY", amount: "100.00", occurred_on: "2026-10-21" },
    });
    expect(evt.status()).toBe(201);

    await page.goto("/#/business/ledger");
    await page.getByLabel("搜索订单").fill(orderNo);
    await page.getByLabel("搜索订单").press("Enter");
    const orderRow = page.getByRole("row").filter({ hasText: orderNo }).first();
    await orderRow.getByRole("button", { name: "返点", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "登记返点" });
    await expect(dialog).toBeVisible();
    await fillByLabel(dialog, "返点金额", "10.00");
    const posted = page.waitForResponse((r) => r.url().endsWith("/rebates") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "确认登记" }).click();
    const response = await posted;
    expect(response.status()).toBe(201);
    expect((await response.json()).source_order_id).toBe(orderBody.id);
    await expect(page.getByText("返点已登记")).toBeVisible({ timeout: 10000 });
    expect(errors).toEqual([]);
  });

  test("业务中心·分期：登记收款", async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    // 每次创建独立账号，保留测试凭证后仍可重复运行。
    const order = await request.post(`${API_BASE}/orders`, {
      headers: ADMIN,
      data: {
        order_type: "HS", trade_date: "2026-10-21",
        account_snapshot: { game_account: `e2e-payment-${Date.now()}`, game_type: "王者荣耀" },
        form_extra: { business_responsible_ids: [1] },
      },
    });
    expect(order.status()).toBe(201);
    const orderId = (await order.json()).id as number;
    const buy = await request.post(`${API_BASE}/orders/${orderId}/events`, {
      headers: ADMIN,
      data: { event_type: "BUY", amount: "1200.00", occurred_on: "2026-10-21" },
    });
    expect(buy.status()).toBe(201);
    const inst = await request.post(`${API_BASE}/installments`, {
      headers: ADMIN,
      data: {
        order_id: orderId,
        contract_type: "STOCK_SALE",
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
    // 分期面板只剩「分期出售」Tab（代分期已下线），STOCK_SALE 合约直接在默认 Tab 内渲染。

    const row = page.locator(".ant-table-row", { hasText: instNo }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.getByRole("button", { name: "登记收款" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("本次实收").fill("400.00");
    await dialog.getByLabel("收款日期").fill("2026-10-21");
    const paid = page.waitForResponse((response) => /\/installments\/\d+\/payments$/.test(response.url()) && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "确认收款" }).click();
    const response = await paid;
    expect(response.status()).toBe(200);
    const payment = (await response.json()).installment.operation_operators.find(
      (operation: { operation_key: string }) => operation.operation_key.startsWith("PAY:"),
    );
    expect(payment.period_no).toBe(1);
    expect(payment.flow_no).toBeTruthy();
    await expect(page.getByText("收款已登记")).toBeVisible({ timeout: 10000 });
    await row.locator(".ant-table-row-expand-icon").click();
    await expect(page.getByText(`收款（第1期，${payment.flow_no}）`)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
