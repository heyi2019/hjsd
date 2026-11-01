/** L270 回归：统一 Select 关闭虚拟列表，长选项列表下全部选项进入 DOM，
 *  无障碍辅助树完整暴露（不再只暴露前两项）。 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Select } from "./Select";
import { renderLight } from "../../test/render";

const MANY = Array.from({ length: 20 }, (_, i) => ({ value: `v${i}`, label: `选项${i}` }));

it("L270：关闭虚拟列表后，全部选项渲染进 DOM（辅助树完整）", async () => {
  const user = userEvent.setup();
  renderLight(<Select options={MANY} placeholder="请选择" />, { user: "admin" });

  await user.click(screen.getByText("请选择").closest(".ant-select-selector")!);

  // 全部 20 个选项都应在 DOM 中（虚拟列表开启时只渲染可视区子集）
  const rendered = document.querySelectorAll(".ant-select-item-option");
  expect(rendered.length).toBe(MANY.length);
  for (let i = 0; i < MANY.length; i += 1) {
    expect(screen.getByText(`选项${i}`)).toBeInTheDocument();
  }
});
