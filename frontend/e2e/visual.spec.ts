import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * 等元素几何位置连续两次采样一致再动手。
 * 原因：antd 弹窗入场是 scale 动画、页面还有弹簧入场，固定 waitForTimeout 在快机器上会
 * 恰好卡在动画中间态——此时 getBoundingClientRect 返回缩放后的假尺寸（1200×0.2=240）与假位置，
 * 拖动/缩放断言会随机红绿（实测同一用例两次跑一红一绿）。
 */
async function waitStableGeometry(locator: Locator) {
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
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

/**
 * 视觉回归基线：只截取稳定的工作台壳层，不依赖真实后端数据。
 * 页面入口和导航是最容易被响应式改动误伤的区域，桌面/移动各保留一张基线。
 */
test.describe("UI visual regression", () => {
  test("工作台 desktop", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "今天从这里开始" })).toBeVisible();
    await expect(page).toHaveScreenshot("dashboard-desktop.png", {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
      // 「今日关注」两个计数取自真实库数据，别的 spec 写订单后数字会变（47px 抖动）。
      // 遮掉动态数值，只锁布局与排版。
      mask: [page.locator(".dashboard-summary .ui-stat__value")],
    });
  });

  test("工作台 mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "今天从这里开始" })).toBeVisible();
    await expect(page).toHaveScreenshot("dashboard-mobile.png", {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
      // 同 desktop：遮掉随库数据变化的计数。
      mask: [page.locator(".dashboard-summary .ui-stat__value")],
    });
  });

  test("移动端更多导航可达", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "更多导航" }).click();
    await expect(page.getByRole("dialog", { name: "更多" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "经营中心" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "设置" })).toBeVisible();
    await page.getByRole("menuitem", { name: "经营中心" }).click();
    await expect(page.locator(".topbar__page")).toHaveText("经营中心");
    await expect(page.getByRole("dialog", { name: "更多" })).toBeHidden();
  });

  test("回收页响应式表单：四种视口不溢出", async ({ page }) => {
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1440, height: 900 },
      { width: 900, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await page.getByRole("button", { name: /自营·回收/ }).click();
      const modal = page.locator(".recovery-order-modal");
      await expect(modal.getByText("游戏账号信息")).toBeVisible();
      // 等弹窗算好响应式布局（data-recovery-layout）且几何位置稳定后再测量。
      await expect(modal.locator(".ant-modal")).toHaveAttribute("data-recovery-layout", /.+/);
      await waitStableGeometry(modal.locator(".ant-modal"));

      const overflow = await modal.evaluate((node) => {
        const body = node.querySelector(".ant-modal-body");
        const entry = node.querySelector(".recovery-entry-fields");
        // 用字段 id 定位密码框：entry 内第 1 个 input 是「游戏类型」Select 的搜索框（宽度仅 1px 级），
        // 按 index 取会误命中，必须按 antd Form.Item name 生成的 id 精确取。
        const password = entry?.querySelector<HTMLInputElement>('input#game_password');
        if (!body || !entry || !password) return { valid: false };
        const columns = getComputedStyle(entry).gridTemplateColumns.trim().split(/\s+/).length;
        return {
          valid: true,
          entryOverflow: entry.scrollWidth > entry.clientWidth + 1,
          // 用 offsetWidth（布局宽度）而非 getBoundingClientRect：
          // antd 弹窗入场是 scale 动画，rect 会返回缩放后尺寸（159×0.2≈31.8）造成假失败。
          passwordWidth: password.offsetWidth,
          columns,
        };
      });

      expect(overflow.valid).toBe(true);
      expect(overflow.entryOverflow).toBe(false);
      expect(overflow.passwordWidth).toBeGreaterThanOrEqual(viewport.width <= 900 ? 110 : 140);
      expect(overflow.columns).toBe(viewport.width >= 1440 ? 4 : viewport.width <= 640 ? 1 : 2);
      const paymentRows = modal.locator(".payment-info-fields > .ant-form-item .ant-form-item-row");
      await expect(paymentRows.first()).toHaveCSS("flex-wrap", "nowrap");
      const submit = modal.getByRole("button", { name: "创建订单" });
      const body = modal.locator(".ant-modal-body");
      const bodyCanScroll = await body.evaluate((node) => node.scrollHeight > node.clientHeight);
      expect(bodyCanScroll).toBe(true);
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
    const shell = page.locator(".resizable-modal__drag-shell");
    const modal = page.locator(".recovery-order-modal .ant-modal");
    // 等待响应式布局落定：入场 scale 动画期间 getBoundingClientRect 会返回 1200×0.2 的假宽度。
    await expect(modal).toHaveAttribute("data-recovery-layout", /.+/);
    await waitStableGeometry(modal);
    const before = await modal.evaluate((node) => node.getBoundingClientRect().toJSON());
    const handle = page.locator(".resizable-modal__drag-handle");
    const point = await handle.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.left + 24, y: rect.top + rect.height / 2 };
    });

    await dragMouseSteps(page, point, { x: point.x + 120, y: point.y + 80 });

    // 强信号：拖拽 handler 一旦激活必然把 modal 置为 fixed（ResizableModal.tsx startDrag），
    // 与「测试 before 读数」和「应用 pointerdown 基线」之间的竞态无关。
    expect(await modal.evaluate((node) => node.style.position)).toBe("fixed");
    // 位移断言只防「完全没拖动」（0px）：阈值取手势的一半即可。100px 硬阈值在
    // before 读数与 pointerdown 基线错位（页面弹簧入场/数据加载位移）时会误报。
    const after = await modal.evaluate((node) => node.getBoundingClientRect().toJSON());
    expect(after.x).toBeGreaterThan(before.x + 60);
    expect(after.y).toBeGreaterThan(before.y + 40);
  });

  test("回收页桌面弹窗四角可缩放", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: /自营·回收/ }).click();
    const modal = page.locator(".recovery-order-modal .ant-modal");
    await expect(modal).toBeVisible();
    await expect(page.locator(".resizable-modal__resize-handle--se")).toBeVisible();
    await expect(modal).toHaveAttribute("data-recovery-layout", /.+/);
    await waitStableGeometry(modal);
    // 再等弹窗撑到初始宽度：入场动画期间 offsetWidth 可能仍是压缩态，
    // 拿它推算拖拽距离会把弹窗一路拖成 single（实测全量跑时随机出现）。
    await expect
      .poll(() => modal.evaluate((node) => (node as HTMLElement).offsetWidth), { timeout: 8000 })
      .toBeGreaterThan(1000);
    for (const [targetWidth, layout] of [[1100, "three"], [900, "double"], [600, "single"]] as const) {
      const currentWidth = await modal.evaluate((node) => (node as HTMLElement).offsetWidth);
      const handle = page.locator(".resizable-modal__resize-handle--se");
      const point = await handle.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await dragMouseSteps(page, point, {
        x: point.x - (currentWidth - targetWidth),
        y: point.y - 100,
      });
      await expect(modal).toHaveAttribute("data-recovery-layout", layout);
      await expect.poll(() => modal.locator(".recovery-entry-fields").evaluate((node) => {
        return getComputedStyle(node).gridTemplateColumns.split(" ").length;
      })).toBe(layout === "single" ? 1 : layout === "double" ? 2 : 3);
    }
  });

  test("回收页桌面弹窗四边可缩放", async ({ page }) => {
    // 4 个方向各自 goto + 开窗 + 等动画收敛 + 拖动，默认 30s 在全量负载下不够
    // （实测一次 30s 超时），慢速化三倍预算。
    test.slow();
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [direction, deltaX, deltaY, dimension] of [
      ["e", -100, 0, "width"],
      ["w", 100, 0, "width"],
      ["s", 0, 100, "height"],
      ["n", 0, -100, "height"],
    ] as const) {
      await page.goto("/");
      await page.getByRole("button", { name: /自营·回收/ }).click();
      const modal = page.locator(".recovery-order-modal .ant-modal");
      const handle = page.locator(`.resizable-modal__resize-handle--${direction}`);
      await expect(modal).toBeVisible();
      await expect(handle).toBeVisible();
      await expect(modal).toHaveAttribute("data-recovery-layout", /.+/);
      await waitStableGeometry(modal);
      await waitStableGeometry(handle);
      // 用 offsetWidth/offsetHeight（布局尺寸）：入场 scale 动画期间 getBoundingClientRect 会返回缩放后的假尺寸。
      const before = await modal.evaluate((node) => {
        const el = node as HTMLElement;
        return { width: el.offsetWidth, height: el.offsetHeight };
      });
      const point = await handle.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await dragMouseSteps(page, point, { x: point.x + deltaX, y: point.y + deltaY });
      const after = await modal.evaluate((node) => {
        const el = node as HTMLElement;
        return { width: el.offsetWidth, height: el.offsetHeight };
      });
      if (dimension === "width") {
        expect(after.width).toBeLessThan(before.width - 50);
      } else {
        expect(after.height).toBeGreaterThan(before.height + 50);
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
    await expect(page).toHaveScreenshot("login-desktop.png", {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
    });
  });

  test("登录页 mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "用户中心" }).click();
    await expect(page.getByRole("dialog", { name: "用户中心" })).toBeVisible();
    await page.getByRole("dialog", { name: "用户中心" }).getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByRole("heading", { name: "登录工作台" })).toBeVisible();
    await expect(page).toHaveScreenshot("login-mobile.png", {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
    });
  });
});
