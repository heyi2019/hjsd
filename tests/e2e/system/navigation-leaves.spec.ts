import { expect, test, type Page } from "@playwright/test";
import { navItem } from "../support/api-stub";

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
 * 设置页保留固定的管理员入口断言，同时动态遍历实际渲染的页签。
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
    tabs: ["总览", "资金明细", "工作室运营", "押金", "对账"],
  },
  {
    nav: "经营中心",
    tabs: [
      "经营损益",
      "分润对账",
      "订单利润",
      "数据中心",
    ],
  },
  {
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
 * 坑 1（溢出收纳）：经营中心 Tab 在 1280 视口下总宽超限时，antd 把尾部 Tab
 * 收进「更多 ⌄」下拉——nav 里残留的
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
      // 短超时：CI 负载下 click 偶发卡在 actionability 自动等待上，若不限定会
      // 把用例自带 195s 预算悄悄吃光（表现为「超时失败」）。限定 5s 让卡点快速
      // 失败，配合 config 的 retries 廉价重试，整轮不会被一个卡点拖沉。
      await page.locator(".ant-tabs-nav-more").first().click({ timeout: 5000 });
      await page
        .locator(".ant-tabs-dropdown-menu-item", { hasText: label })
        .first()
        .click({ timeout: 5000 });
    } else {
      await tab.scrollIntoViewIfNeeded({ timeout: 5000 });
      await tab.click({ timeout: 5000 });
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
 * 一并返回。避免硬编码 Tab 清单过时（如「表单字段」曾错写成旧字段，且漏掉权限门控的编号序列）。
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
    // 本用例逐 Tab 依次切换并各做两次断言，耗时随 Tab 数线性增长。
    // 正常负载下约 8s，但全量串行跑 + 机器有其它负载（同机并行 vite/build 进程）时会
    // 明显变慢，曾出现顶到预算超时、单独跑却秒过 的 flaky。这里按 Tab 数给足预算
    // （15s/Tab，约实测上限 2x 余量；下限 60s），不放松任何断言——超时只用来区分
    // 「慢」与「真的走不通」（真卡住远超时仍会失败）。
    test.setTimeout(Math.max(60_000, (center.dynamic ? 13 : center.tabs!.length) * 15_000));

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await enterApp(page);
    await navItem(page, center.nav).click();
    await expect(page.locator(".topbar__page")).toHaveText(center.nav);

    const labels = center.dynamic ? await readSettingsTabs(page) : center.tabs!;
    if (center.nav === "设置") {
      expect(labels).toEqual(expect.arrayContaining(["业务字典", "配置中心", "订单导入", "人员与团队", "审计记录", "外观"]));
    }
    for (const label of labels) {
      await clickTab(page, label);
      const tab = tabByName(page, label);
      await expect(tab).toHaveAttribute("aria-selected", "true");

      // 激活面板可见：不能直接用 .ant-tabs-tabpane-active——页面存在嵌套 Tabs
      // （如设置面板内部还有嵌套子 Tab），类选择器会
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
