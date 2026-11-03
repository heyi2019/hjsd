import { expect, test, type Page } from "@playwright/test";
import { navItem } from "./support/api-stub";

/**
 * 全叶子走查：smoke.spec.ts 只覆盖「6 个一级导航可达（外壳）」，本 spec 补齐
 * **二级 Tab 叶子**——每个中心的内层 Tab 逐个点入，断言：
 *   1) 该 Tab 获得 aria-selected="true"（真的切过去了，不是点到外壳）；
 *   2) 激活面板可见且非空（挂载出内容，不是白屏/空 pane）；
 *   3) 全程无未捕获 pageerror（前端崩了会在这里现形）。
 *
 * 与 smoke 一样走**真实后端 + DEV 态零登录**（smoke 同口径：AppShell 在 DEV 态
 * 挂载即可用，登录/JWT 链路由 auth-login.spec.ts 守），不拦 API——数据层由
 * business-write / finance-write-ui 等写路径 spec 负责，本 spec 只守
 * 「每个叶子都能开」这条主干。
 *
 * 维护提示：业务/客户/资金/经营中心的 Tab 文案来自各页面源码；「设置」中心不硬编码，
 * 改由 readSettingsTabs 从 SettingsPage 真实渲染动态读取（含权限门控与溢出收纳的 Tab），
 * 设置页增删 Tab 当天即自动覆盖，无需手动同步。
 */

const CENTERS: Array<{ nav: string; tabs?: string[]; dynamic?: boolean }> = [
  {
    nav: "业务中心",
    tabs: ["库存中心", "订单台账", "分期与回款"],
  },
  {
    nav: "客户中心",
    tabs: ["客户档案", "合作方（同行/供货方/平台）", "客户需求池"],
  },
  {
    nav: "资金中心",
    // 与 FundsPage.tsx 的 Tabs items 保持一致：原「返点」已更名「返点明细」、
    // 新增「工作室支出」页签；「押金」已从一级 Tab 移除（押金占用现归到总览/异常）。
    // 增删 Tab 时需同步此列表（当前 6 个）。
    tabs: ["总览", "流水", "对账", "异常", "返点明细", "工作室支出"],
  },
  {
    nav: "经营中心",
    tabs: [
      "库存 R1",
      "月度损益 R2",
      "提成对账 R3",
      "资金日报 R4",
      "业务损益 R5",
      "资金属性分析",
      "订单利润",
      "数据中心",
      "质量中心",
      "系统提醒",
      "全局搜索",
      "审计记录",
      "附件中心",
    ],
  },
  {
    // 设置页 Tab 不硬编码：从 SettingsPage 真实渲染的 Tab（含溢出收纳到「更多」的）
    // 动态读取，单一事实源，增删 Tab 当天即被走查覆盖。
    nav: "设置",
    dynamic: true,
  },
];

/**
 * antd 会给中文 Tab 文案插入空格（与「退 出」按钮同源），故 accessible name
 * 用逐字符 `\s*` 容错匹配，避免 exact 匹配被插空格打断。
 */
function tabByName(page: Page, label: string) {
  return page.getByRole("tab", { name: new RegExp(`^${label.split("").join("\\s*")}$`) });
}

/**
 * 点击某个 Tab 并确认选中，自动处理 antd 的**溢出收纳**与高负载下的点击丢失。
 *
 * 坑 1（溢出收纳）：经营中心 13 个 Tab 在 1280 视口下总宽超限，antd 把尾部 Tab
 * （如「质量中心」，实测 x=1286 已超出视口）收进「更多 ⌄」下拉——nav 里残留的
 * 元素点击不生效（aria-selected 恒 false）。判定用几何位置：tab 右缘越过视口
 * 右侧预留区（-80px 给 more 按钮留位）即走「更多 → 下拉项」路径。
 *
 * 坑 2（点击被吞）：全量跑时机器高负载（实测 load 27），页面数据渲染期间 antd
 * Tabs 重排会吞掉点击——locator 解析成功、click 不报错，但 aria-selected 仍为
 * false（订单利润 Tab 实测 24 次采样均 false）。故点击后校验，未生效则重试；
 * 溢出判定每次 attempt 重算（布局随负载漂移，不能一次定死）。
 */
async function clickTab(page: Page, label: string) {
  const tab = tabByName(page, label);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const box = await tab.boundingBox().catch(() => null);
    const viewportWidth = page.viewportSize()?.width ?? 1280;
    const overflowed = !!box && box.x + box.width > viewportWidth - 80;

    if (overflowed) {
      await page.locator(".ant-tabs-nav-more").first().click();
      await page
        .locator(".ant-tabs-dropdown-menu-item", { hasText: label })
        .first()
        .click();
    } else {
      await tab.scrollIntoViewIfNeeded();
      await tab.click();
    }

    if ((await tab.getAttribute("aria-selected").catch(() => null)) === "true") {
      return;
    }
  }
  // 三次未生效：交回调用方的 expect(tab).toHaveAttribute 产出明确失败，
  // 不在此处 force click——那会把「真的点不上」伪装成通过。
}

async function enterApp(page: Page) {
  await page.goto("/");
  await expect(navItem(page, "工作台")).toBeVisible();
}

/**
 * 动态读取「设置」页真实渲染的 Tab 清单：可见 Tab + 溢出收纳到「更多 ⌄」下拉的 Tab，
 * 一并返回。避免硬编码 10 Tab 过时（如「表单字段/导入」曾错写成旧字段/标准导入，
 * 且漏掉权限门控的 编号序列/改动追溯）。
 *
 * 选标签用 textContent 并压平空白——antd 会给中文 Tab 插空格（与「退 出」同源）；
 * textContent 不受滚动/可见性影响，竖向（tabPosition=left）或横向溢出都读到全量。
 */
async function readSettingsTabs(page: Page): Promise<string[]> {
  const names: string[] = [];
  const visible = page.locator(".settings-tabs .ant-tabs-tab");
  const count = await visible.count();
  for (let i = 0; i < count; i += 1) {
    const text = (await visible.nth(i).textContent())?.replace(/\s+/g, "") ?? "";
    if (text) names.push(text);
  }
  const more = page.locator(".settings-tabs .ant-tabs-nav-more");
  // 桌面端设置页为竖向（tabPosition=left）Tabs，溢出收纳的「更多 ⌄」按钮在 DOM 中存在
  // 但被隐藏（display:none），count() 恒 > 0 却不可点击——必须先用 isVisible() 判定，
  // 否则会误点到隐藏按钮导致 timeout。竖向布局下所有 Tab 本就全部可见，无需走「更多」路径。
  if ((await more.first().isVisible().catch(() => false))) {
    await more.first().click();
    const items = page.locator(".ant-tabs-dropdown .ant-tabs-dropdown-menu-item");
    const ic = await items.count();
    for (let i = 0; i < ic; i += 1) {
      const text = (await items.nth(i).textContent())?.replace(/\s+/g, "") ?? "";
      if (text) names.push(text);
    }
    await page.keyboard.press("Escape");
  }
  return names;
}

for (const center of CENTERS) {
  test(`全叶子走查：${center.nav}（${center.dynamic ? "动态读取" : `${center.tabs!.length} 个`} Tab）`, async ({ page }) => {
    // 本用例逐 Tab 依次切换并各做两次断言，耗时随 Tab 数线性增长（经营中心 13 个）。
    // 正常负载下约 8s，但全量串行跑 + 机器有其它负载时会明显变慢，曾出现 45s 顶到
    // 全局 timeout 而失败、单独跑却 8s 通过的 flaky。这里按 Tab 数给足预算，
    // 不放松任何断言——超时只用来区分「慢」与「真的走不通」。
    test.setTimeout(Math.max(45_000, (center.dynamic ? 13 : center.tabs!.length) * 8_000));

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await enterApp(page);
    await navItem(page, center.nav).click();
    await expect(page.locator(".topbar__page")).toHaveText(center.nav);

    const labels = center.dynamic ? await readSettingsTabs(page) : center.tabs!;
    for (const label of labels) {
      await clickTab(page, label);
      const tab = tabByName(page, label);
      await expect(tab).toHaveAttribute("aria-selected", "true");

      // 激活面板可见：不能直接用 .ant-tabs-tabpane-active——页面存在嵌套 Tabs
      // （如「标准导入」内部还有 原始行/映射预览/导入对账 子 Tab），类选择器会
      // 命中多个触发 strict mode violation。按 tabpanel 的 accessible name
      // （aria-labelledby → 外层 tab）定位，天然限定到被点的这个叶子。
      const pane = page.getByRole("tabpanel", {
        name: new RegExp(`^${label.split("").join("\\s*")}$`),
      });
      await expect(pane).toBeVisible();
    }

    expect(errors).toEqual([]);
  });
}
