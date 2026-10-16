import { expect, test } from "@playwright/test";

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
      await page.getByRole("button", { name: /回收账号/ }).click();
      const modal = page.locator(".recovery-order-modal");
      await expect(modal.getByText("游戏账号信息")).toBeVisible();
      await page.waitForTimeout(350);

      const overflow = await modal.evaluate((node) => {
        const body = node.querySelector(".ant-modal-body");
        const entry = node.querySelector(".recovery-entry-fields");
        const password = entry?.querySelectorAll("input")[2];
        if (!body || !entry || !password) return { valid: false };
        const columns = getComputedStyle(entry).gridTemplateColumns.trim().split(/\s+/).length;
        return {
          valid: true,
          entryOverflow: entry.scrollWidth > entry.clientWidth + 1,
          passwordWidth: (password as HTMLInputElement).getBoundingClientRect().width,
          columns,
        };
      });

      expect(overflow.valid).toBe(true);
      expect(overflow.entryOverflow).toBe(false);
      expect(overflow.passwordWidth).toBeGreaterThanOrEqual(viewport.width <= 900 ? 110 : 140);
      expect(overflow.columns).toBe(viewport.width >= 1440 ? 4 : viewport.width <= 640 ? 1 : 2);
      const paymentRows = modal.locator(".recovery-payment-fields > .ant-form-item .ant-form-item-row");
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
    await page.getByRole("button", { name: /回收账号/ }).click();
    const shell = page.locator(".resizable-modal__drag-shell");
    const modal = page.locator(".recovery-order-modal .ant-modal");
    await page.waitForTimeout(350);
    const before = await modal.evaluate((node) => node.getBoundingClientRect().toJSON());
    const handle = page.locator(".resizable-modal__drag-handle");
    const point = await handle.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.left + 24, y: rect.top + rect.height / 2 };
    });

    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 120, point.y + 80, { steps: 8 });
    await page.mouse.up();

    const after = await modal.evaluate((node) => node.getBoundingClientRect().toJSON());
    expect(after.x).toBeGreaterThan(before.x + 100);
    expect(after.y).toBeGreaterThan(before.y + 60);
  });

  test("回收页桌面弹窗四角可缩放", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: /回收账号/ }).click();
    const modal = page.locator(".recovery-order-modal .ant-modal");
    await expect(modal).toBeVisible();
    await expect(page.locator(".resizable-modal__resize-handle--se")).toBeVisible();
    await page.waitForTimeout(500);
    for (const [targetWidth, layout] of [[1100, "three"], [900, "double"], [600, "single"]] as const) {
      const currentWidth = await modal.evaluate((node) => node.getBoundingClientRect().width);
      const handle = page.locator(".resizable-modal__resize-handle--se");
      const point = await handle.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x - (currentWidth - targetWidth), point.y - 100, { steps: 8 });
      await page.mouse.up();
      await expect(modal).toHaveAttribute("data-recovery-layout", layout);
      await expect.poll(() => modal.locator(".recovery-entry-fields").evaluate((node) => {
        return getComputedStyle(node).gridTemplateColumns.split(" ").length;
      })).toBe(layout === "single" ? 1 : layout === "double" ? 2 : 3);
    }
  });

  test("回收页桌面弹窗四边可缩放", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [direction, deltaX, deltaY, dimension] of [
      ["e", -100, 0, "width"],
      ["w", 100, 0, "width"],
      ["s", 0, 100, "height"],
      ["n", 0, -100, "height"],
    ] as const) {
      await page.goto("/");
      await page.getByRole("button", { name: /回收账号/ }).click();
      const modal = page.locator(".recovery-order-modal .ant-modal");
      const handle = page.locator(`.resizable-modal__resize-handle--${direction}`);
      await expect(modal).toBeVisible();
      await expect(handle).toBeVisible();
      await page.waitForTimeout(350);
      const before = await modal.evaluate((node) => node.getBoundingClientRect().toJSON());
      const point = await handle.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + deltaX, point.y + deltaY, { steps: 8 });
      await page.mouse.up();
      const after = await modal.evaluate((node) => node.getBoundingClientRect().toJSON());
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
    await expect(page.getByRole("heading", { name: "宜游轩 ERP" })).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "宜游轩 ERP" })).toBeVisible();
    await expect(page).toHaveScreenshot("login-mobile.png", {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
    });
  });
});
