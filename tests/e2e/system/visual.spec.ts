import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * 等元素几何位置连续两次采样一致再动手。
 * 原因：antd 弹窗入场是 scale 动画、页面还有弹簧入场，固定 waitForTimeout 在快机器上会
 * 恰好卡在动画中间态——此时 getBoundingClientRect 返回缩放后的假尺寸（1200×0.2=240）与假位置，
 * 拖动/缩放断言会随机红绿（实测同一用例两次跑一红一绿）。
 */
async function waitStableGeometry(locator: Locator) {
  // rc-motion 会在渲染后的帧中才给弹窗加进场类；先让进场调度完成，
  // 再等该类移除，避免把动画开始前的短暂静止误判成最终位置。
  await locator.evaluate(async (node) => {
    if (!node.closest(".ant-modal")) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  });
  await expect.poll(() => locator.evaluate((node) => {
    const modal = node.closest<HTMLElement>(".ant-modal");
    if (!modal) return true;
    const entering = Array.from(modal.classList).some((name) => /^ant-zoom-(appear|enter)/.test(name));
    return !entering && Math.abs(modal.getBoundingClientRect().width - modal.offsetWidth) < 1;
  }), { timeout: 15000 }).toBe(true);
  // 第一判据：入场 scale 动画是否真的结束——transform 回到单位矩阵。
  // 只在低负载时「连续两次采样一致」不够：全量跑时动画偶发卡顿，两帧相同会被误判为已稳定。
  // 轮询窗口按全量实测放宽：机器 load 27 时 rc-motion 的 rAF 动画可停滞 8s 以上
  // （四边可缩放实测卡在 matrix(0.2) 直至 30s 测试超时），8s 窗口不够。
  await expect
    .poll(() => locator.evaluate((node) => getComputedStyle(node).transform), { timeout: 15000 })
    .toMatch(/^(none|matrix\(1,\s*0,\s*0,\s*1)/);
  // 第二判据：几何位置连续两次采样一致（覆盖页面弹簧入场等非 transform 动效）。
  await expect
    .poll(
      async () => {
        const read = () =>
          locator.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
          });
        const first = await read();
        await new Promise((resolve) => setTimeout(resolve, 120));
        return first === (await read());
      },
      { timeout: 12000 },
    )
    .toBe(true);
}

/**
 * 逐帧拖拽：headless Chrome 会把 mousemove 合并进 rAF，全量套件负载下帧率下降，
 * 即便 steps 拆分也可能被合并丢帧，拖拽位移随机缩水（实测 +120px 只生效 78px）。
 * 每步之间等 16ms 强制走一帧，保证位移与手势一致。
 */
async function dragMouseSteps(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
  onDown?: () => Promise<void>,
): Promise<void> {
  // 先缓慢移到起点（steps 插值确保 pointer 真正落在手柄上），落定后再按下，
  // 给 pointerdown 足够时间被 React 处理器捕获——全量套件负载下 headless 会把过密的
  // pointermove 合并进 rAF，单步 wait 拉长是让每帧位移都被处理、避免位移丢失（实测偶发 0 位移）。
  await page.mouse.move(from.x, from.y, { steps: 3 });
  await page.waitForTimeout(30);
  await page.mouse.down();
  if (onDown) await onDown();
  await page.waitForTimeout(30);
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
}

/**
 * 工作台界面基线：只截取稳定的工作台壳层，不依赖真实后端数据。
 * 页面入口和导航是最容易被响应式改动误伤的区域，桌面/移动各保留一张基线。
 */
test.describe("UI visual baseline", () => {
  test("工作台 desktop", async ({ page }) => {
    // 周期选择器显示当前日期区间；固定截图日期，避免跨月后视觉测试误报。
    await page.clock.setFixedTime(new Date("2026-11-23T12:00:00Z"));
    const currentUserResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/me") && response.ok());
    await page.goto("/");
    const currentUser = await (await currentUserResponse).json();
    const greeting = page.getByRole("heading", { name: /^(凌晨好|上午好|中午好|晚上好)，.+$/ });
    await expect(greeting).toContainText(currentUser.display_name?.trim() || currentUser.username);
    await expect(page.getByRole("button", { name: "本期", exact: true })).toBeEnabled();
    // 页脚版本随发布变化，实际文案由 AppShell 用例校验。截图沿用固定文本比对布局。
    await page.locator(".sidebar-foot").evaluate((footer) => {
      footer.textContent = "宜游轩 · 经营工作台";
    });
    // 用户资料加载完成后再固定标题，避免会话更新覆盖截图文案。
    await greeting.evaluate((heading) => { heading.textContent = "今天从这里开始"; });
    await expect(page).toHaveScreenshot("workbench-desktop.png", {
      animations: "disabled",
      caret: "hide",
      // 只截视口（默认 720 高）：全页模式会把文档流后段（业务总览/我的消息）一并拍入，
      // 叠加 fixed 底部导航成像成「导航之下还有内容」的怪异基线；锁布局的目的在入口卡与导航。
      // 「今日关注」两个计数取自真实库数据，别的 spec 写订单后数字会变（47px 抖动）。
      // 遮掉动态数值，只锁布局与排版。
      // 「我的消息」条目（如「新的分润通知 N 条」）同样随库数据变化（59px 抖动），一并遮掉。
      // maskColor 用中性灰：默认 magenta 会在基线图里留大片刺眼品红（实为遮罩色，非页面渲染缺陷）。
      maskColor: "#8a8a8a",
      mask: [
        page.locator(".workbench-summary .ui-stat__value"),
        page.locator('section[aria-label="我的消息"]'),
      ],
    });
  });

  test("工作台 mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.setFixedTime(new Date("2026-11-23T12:00:00Z"));
    const currentUserResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/me") && response.ok());
    await page.goto("/");
    const currentUser = await (await currentUserResponse).json();
    const greeting = page.getByRole("heading", { name: /^(凌晨好|上午好|中午好|晚上好)，.+$/ });
    await expect(greeting).toContainText(currentUser.display_name?.trim() || currentUser.username);
    const brand = page.getByRole("heading", { name: "宜游轩", exact: true });
    await expect(brand).toBeVisible();
    await expect(brand.locator(".app-brand__mark")).toBeVisible();
    // 品牌由上面的断言覆盖，截图继续使用固定页名比较原有布局。
    await page.locator(".topbar__title").evaluate((title) => {
      title.querySelector<HTMLElement>(".topbar__brand")!.style.display = "none";
      title.querySelector<HTMLElement>(".topbar__page")!.style.display = "block";
    });
    await expect(page.getByRole("button", { name: "本期", exact: true })).toBeEnabled();
    // 退出入口在移动端导航用例单独验证，布局基线沿用原工具栏。
    await page.locator(".topbar-action--logout").evaluate((button) => { button.style.display = "none"; });
    // 用户资料加载完成后再固定标题，避免会话更新覆盖截图文案。
    await greeting.evaluate((heading) => { heading.textContent = "今天从这里开始"; });
    await expect(page).toHaveScreenshot("workbench-mobile.png", {
      animations: "disabled",
      caret: "hide",
      // 同 desktop：只截视口，避免全页把折叠线下的总览/消息区拍入。
      // 同 desktop：遮掉随库数据变化的计数。
      // 「我的消息」条目（如「新的分润通知 N 条」）同样随库数据变化（59px 抖动），一并遮掉。
      // maskColor 用中性灰：默认 magenta 会在基线图里留大片刺眼品红（实为遮罩色，非页面渲染缺陷）。
      maskColor: "#8a8a8a",
      mask: [
        page.locator(".workbench-summary .ui-stat__value"),
        page.locator('section[aria-label="我的消息"]'),
      ],
    });
  });

  test("移动端更多导航可达", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.locator(".topbar").getByRole("button", { name: "退出登录" })).toBeVisible();
    await page.getByRole("button", { name: "更多导航" }).click();
    await expect(page.getByRole("dialog", { name: "更多" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "经营中心" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "设置" })).toBeVisible();
    await page.getByRole("menuitem", { name: "经营中心" }).click();
    await expect(page.locator(".topbar__page")).toHaveText("经营中心");
    await expect(page.locator(".topbar").getByRole("heading", { name: "宜游轩", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "更多" })).toBeHidden();
  });

  test("紧凑宽度下业务页内容不被导航行的剩余高度推下去", async ({ page }) => {
    // 1904px Retina 截图对应约 952 CSS px；此时 AppShell 会切换为顶部横向导航。
    await page.setViewportSize({ width: 952, height: 704 });

    for (const path of ["/#/business/ledger", "/#/customers", "/#/funds", "/#/operations"]) {
      await page.goto(path);
      await expect(page.locator(".topbar")).toBeVisible();

      const gap = await page.evaluate(() => {
        const sidebar = document.querySelector<HTMLElement>(".sidebar");
        const main = document.querySelector<HTMLElement>(".main");
        if (!sidebar || !main) return Number.POSITIVE_INFINITY;
        return main.getBoundingClientRect().top - sidebar.getBoundingClientRect().bottom;
      });

      expect(gap, `${path} 的导航与内容之间出现悬空间距`).toBeLessThanOrEqual(1);
    }
  });

  test("回收页响应式表单：四种视口下弹窗可用且不溢出", async ({ page }) => {
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1440, height: 900 },
      { width: 900, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await page.getByRole("button", { name: /自营·回收/ }).click();
      const modal = page.locator(".business-registration-modal .ant-modal").first();
      await expect(modal).toBeVisible();
      const form = modal.locator(".business-registration-form");
      await expect(form).toBeVisible();
      await waitStableGeometry(form);
      // 账号信息分区（旧 recovery-entry-fields 现由统一 account-section 承载）+ 资金明细分区均存在。
      await expect(modal.getByText("游戏账号信息")).toBeVisible();
      await expect(modal.getByText("资金明细")).toBeVisible();

      const metrics = await form.evaluate((node) => {
        const password = node.querySelector<HTMLInputElement>("input#game_password");
        const fields = node.querySelector<HTMLElement>(".business-registration-section__fields");
        return {
          passwordWidth: password ? password.offsetWidth : 0,
          // 列数由「弹窗容器宽度」的 container query 决定（非视口）：>1040→4、≤1040→3、≤760→2、≤520→1。
          // 桌面态弹窗按字段数定宽 1200 且视口够宽 → 4 列；移动端被 .ant-modal max-width 钳到单/少列。
          columns: fields ? getComputedStyle(fields).gridTemplateColumns.trim().split(/\s+/).length : 0,
        };
      });
      expect(metrics.passwordWidth).toBeGreaterThanOrEqual(viewport.width <= 900 ? 110 : 140);
      if (viewport.width >= 1440) expect(metrics.columns).toBe(4);
      if (viewport.width <= 640) expect(metrics.columns).toBe(1);
      // 弹窗整体不溢出视口、页面无横向滚动（表单内部个别多选框的固有最小宽度溢出属已知产品问题，单独跟踪）。
      const fit = await page.evaluate(() => ({
        pageScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
        modalFits: (() => {
          const m = document.querySelector<HTMLElement>(".business-registration-modal .ant-modal");
          if (!m) return true;
          const r = m.getBoundingClientRect();
          return r.left >= -1 && r.right <= window.innerWidth + 1;
        })(),
      }));
      expect(fit.pageScroll).toBe(true);
      expect(fit.modalFits).toBe(true);

      // 资金明细（旧 recovery-fees）：付款金额汇总行与「创建订单」可达，弹窗体可滚动以露出提交。
      const submit = modal.getByRole("button", { name: "创建订单" });
      const body = modal.locator(".ant-modal-body");
      await body.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await expect.poll(() => body.evaluate((node) => node.scrollTop > 0)).toBe(true);
      await submit.scrollIntoViewIfNeeded();
      await expect(submit).toBeVisible();
      await page.keyboard.press("Escape");
    }
  });

  test("回收页桌面弹窗可用普通鼠标拖动", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: /自营·回收/ }).click();
    const modal = page.locator(".business-registration-modal .ant-modal").first();
    await expect(modal).toBeVisible();
    await waitStableGeometry(modal);
    const handle = page.locator(".resizable-modal__drag-handle");
    const point = await handle.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.left + 24, y: rect.top + rect.height / 2 };
    });

    // 基线必须在 pointerdown 之后、首次位移之前读：弹窗入场是「从窄到宽撑开」动画，
    // 撑开过程中重新居中会让 pointerdown 之前读的几何值与应用 startDrag 捕获的
    // initial 相差近百 px（实测 245.7 vs 147.6，终点 267.6 即 147.6+120）。
    // down 与首个 move 之间拖拽尚未激活（6px 阈值），此刻 rect == 应用的 initial。
    let before: { x: number; y: number } | null = null;
    await dragMouseSteps(
      page,
      point,
      { x: point.x + 200, y: point.y + 120 },
      12,
      async () => {
        before = await modal.evaluate((node) => {
          const r = node.getBoundingClientRect();
          return { x: r.x, y: r.y };
        });
      },
    );

    // 强信号：拖拽 handler 一旦激活必然把 modal 置为 fixed（ResizableModal.tsx startDrag）。
    expect(await modal.evaluate((node) => node.style.position)).toBe("fixed");
    const after = await modal.evaluate((node) => node.getBoundingClientRect().toJSON());
    // 全量套件负载下 headless 会把 pointermove 合并进 rAF，位移可能略缩水，故阈值留余量（拖拽 200/120）。
    expect(after.x).toBeGreaterThan(before!.x + 80);
    expect(after.y).toBeGreaterThan(before!.y + 60);
  });

  test("回收页桌面弹窗四角可缩放并触发列数回流", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: /自营·回收/ }).click();
    const modal = page.locator(".business-registration-modal .ant-modal").first();
    await expect(modal).toBeVisible();
    await expect(page.locator(".resizable-modal__resize-handle--se")).toBeVisible();
    await waitStableGeometry(modal);
    // 入场动画期间 offsetWidth 可能仍是压缩态，拿它推算拖拽距离会把弹窗一路拖成窄版（实测全量跑时随机出现）。
    await expect
      .poll(() => modal.evaluate((node) => (node as HTMLElement).offsetWidth), { timeout: 8000 })
      .toBeGreaterThan(1000);
    // 列数由「弹窗容器宽度」的 container query 决定（非视口）：>1040→4、≤1040→3、≤760→2、≤520→1。
    // 目标宽度取各档位安全带中央（与相邻断点各留 ≥120px 余量），避免负载下 pointermove 合并/末帧过头而踩断点。
    for (const [targetWidth, expectCols] of [[1120, 4], [900, 3], [640, 2]] as const) {
      const handle = page.locator(".resizable-modal__resize-handle--se");
      // 全量负载下 headless 偶发把 pointerdown 落在 18px 角手柄「外侧」，退化成移动弹窗
      // （width 保持初始 1200），导致缩放断言失败。故最多重试 2 次：每次先等手柄几何稳定、
      // 用 hover 把指针精确压到手柄中心再按下拖拽，落点后校验 width 确实减小再继续。
      let resized = false;
      for (let attempt = 0; attempt < 2 && !resized; attempt += 1) {
        const beforeWidth = await modal.evaluate((node) => (node as HTMLElement).offsetWidth);
        await waitStableGeometry(modal);
        await waitStableGeometry(handle);
        const box = (await handle.boundingBox())!;
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await handle.hover();
        await dragMouseSteps(page, point, {
          x: point.x - (beforeWidth - targetWidth),
          y: point.y - 200,
        }, 16);
        const afterWidth = await modal.evaluate((node) => (node as HTMLElement).offsetWidth);
        resized = afterWidth < beforeWidth - 50;
      }
      expect(resized, "SE 角缩放未生效（width 未减小，疑似 pointerdown 未命中角手柄）").toBe(true);
      // 强信号：缩放后列数必须回落到该容器宽度对应的档位。
      await expect
        .poll(() => modal.locator(".business-registration-form").evaluate((node) => {
          return getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/).length;
        }), { timeout: 8000 })
        .toBe(expectCols);
    }
  });

  test("回收页桌面弹窗四边可缩放", async ({ page }) => {
    // 4 个方向各自 goto + 开窗 + 等动画收敛 + 拖动，默认 30s 在全量负载下不够
    // （实测一次 30s 超时），慢速化三倍预算。
    test.slow();
    // 视口加高到 1200：拖「南」边向下增高时不会被 heightCeiling（视口高-32）钳死，保证高度确有增量。
    await page.setViewportSize({ width: 1440, height: 1200 });
    for (const [direction, deltaX, deltaY, dimension] of [
      ["e", -240, 0, "width"],
      ["w", 240, 0, "width"],
      ["s", 0, 240, "height"],
      ["n", 0, -240, "height"],
    ] as const) {
      await page.goto("/");
      await page.getByRole("button", { name: /自营·回收/ }).click();
      const modal = page.locator(".business-registration-modal .ant-modal").first();
      const handle = page.locator(`.resizable-modal__resize-handle--${direction}`);
      await expect(modal).toBeVisible();
      await expect(handle).toBeVisible();
      await waitStableGeometry(modal);
      await waitStableGeometry(handle);
      // 用 offsetWidth/offsetHeight（布局尺寸）：入场 scale 动画期间 getBoundingClientRect 会返回缩放后的假尺寸。
      // 高度经 --resizable-modal-height 内联变量生效（未拖过该变量为空，回退到实际像素高度）。
      const readSize = () => modal.evaluate((node) => {
        const el = node as HTMLElement;
        return {
          width: el.offsetWidth,
          heightVar: parseFloat(el.style.getPropertyValue("--resizable-modal-height")) || el.offsetHeight,
        };
      });
      const before = await readSize();
      const point = await handle.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await dragMouseSteps(page, point, { x: point.x + deltaX, y: point.y + deltaY }, 14);
      if (dimension === "width") {
        // 负载下 pointermove 会被合并、位移缩水，故拖拽距离取 240、阈值留余量（拖南/北边均增高窗口）。
        // 用 poll 等 resize 处理器把宽度真正写回，避免 mouse.up 后状态更新滞后导致偶发断言失败。
        await expect
          .poll(async () => (await readSize()).width, { timeout: 5000 })
          .toBeLessThan(before.width - 60);
      } else {
        // 高度经 --resizable-modal-height 变量生效：拖南边向下、拖北边向上都会把窗口拉高，故两方向均增高。
        // 同样用 poll 等变量落地，消除全量负载下「拖完即读、变量尚未应用」的 flake。
        await expect
          .poll(async () => (await readSize()).heightVar, { timeout: 5000 })
          .toBeGreaterThan(before.heightVar + 60);
      }
    }
  });

  test("登录页 desktop", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "退出登录" }).click();
    // 顶栏「退出登录」包在 Popconfirm 内：第一次点击只弹确认框，必须再点「退出」才真正登出。
    // 注意 antd 会给两字按钮自动插空格（DOM 文本是「退 出」），只能用正则匹配，且锚定避免命中「退出登录」。
    await page.getByRole("button", { name: /^退\s*出$/ }).click();
    await expect(page.getByRole("heading", { name: "登录工作台" })).toBeVisible();
    await expect(page.getByLabel("用户名")).toBeVisible();
    await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeInViewport();
  });

  test("登录页 mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "退出登录" }).click();
    await page.getByRole("button", { name: /^退\s*出$/ }).click();
    await expect(page.getByRole("heading", { name: "登录工作台" })).toBeVisible();
    await expect(page.getByLabel("用户名")).toBeVisible();
    await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
