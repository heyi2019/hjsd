import { expect, test } from "@playwright/test";

/**
 * 回归：建单弹窗的「放弃未保存的建单内容？」确认框必须能被关掉。
 *
 * 回归覆盖：取消按钮与确认弹窗必须可用：
 *  确认框曾被渲染成 `BusinessActionModal` 的 children。主弹窗一旦 `open=false`，
 *  嵌套 Modal 的关闭渲染被跳过 —— DOM 卡在可见状态，而 React state 已经是 false。
 *  此后点 X / 点「继续编辑」都是把 false 再设成 false 的幂等 setState，React 直接
 *  bail out 不重渲染，于是弹窗「看得见、就是关不掉」，只能刷新页面。
 *
 * 为什么单测没抓到：组件测试里 `onClose` 是 `vi.fn()` 间谍，父组件并不会真的把
 *  `open` 置为 false，所以「主弹窗真关闭 + 确认框真隐藏」这条路径从未被执行。
 * 只有在真实浏览器里跑真实受控状态才能暴露，故以 E2E 守护。
 *
 * 三个必须成立的收尾（缺一即为退化为旧缺陷）：
 *  ① 点确认框 X   → 确认框消失、表单仍在（等同「继续编辑」）
 *  ② 点「继续编辑」→ 确认框消失、表单仍在
 *  ③ 点「放弃」   → 确认框与主弹窗一并关闭，不残留
 */
test("建单弹窗：放弃确认框可用 X / 继续编辑 / 放弃 三种方式正常收尾", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const mainModal = page.locator(".business-registration-modal");
  // 确认框是独立 portal，用其 Modal 类定位；关闭动画期间仍在 DOM，故以可见性判定。
  const confirm = page.locator(".heijin-fast-confirm");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天从这里开始" })).toBeVisible();

  await page.getByText("自营·回收").first().click();
  await expect(mainModal).toBeVisible();
  await expect(page.getByText("新建回收订单")).toBeVisible();

  // 制造脏值：不填值时点关闭是直接关，不会弹确认框。
  // 必须填「真的注册在 Form 上的字段」——弹窗首个 input 可能是下拉框内嵌的
  // search/readonly 输入，填它不会进 form 值，dirty 判定为 false，也就不会弹确认框。
  const accountInput = mainModal
    .locator('.ant-form-item:has(.ant-form-item-label:has-text("游戏账号"))')
    .locator("input")
    .first();
  await accountInput.fill("E2E·放弃确认");
  await expect(accountInput).toHaveValue("E2E·放弃确认");

  // ① 点确认框 X：确认框收起，回到表单继续编辑。
  await mainModal.locator(".ant-modal-close").first().click();
  await expect(confirm).toBeVisible();
  await confirm.locator(".ant-modal-close").click();
  await expect(confirm).toBeHidden();
  await expect(mainModal).toBeVisible();

  // ② 点「继续编辑」：同上，且不触发 onClose。
  await mainModal.locator(".ant-modal-close").first().click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "继续编辑" }).click();
  await expect(confirm).toBeHidden();
  await expect(mainModal).toBeVisible();

  // ③ 点「放弃」：确认框与主弹窗必须同时消失，不得残留可见确认框。
  //    注：antd 会给双字按钮插空格（「放 弃」），故用正则而非精确名。
  await mainModal.locator(".ant-modal-close").first().click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: /放\s*弃/ }).click();
  await expect(confirm).toBeHidden();
  await expect(mainModal).toBeHidden();

  // 收尾：重新打开不得带出上一个确认框。
  await page.getByText("自营·回收").first().click();
  await expect(mainModal).toBeVisible();
  await expect(confirm).toBeHidden();

  expect(errors).toEqual([]);
});
