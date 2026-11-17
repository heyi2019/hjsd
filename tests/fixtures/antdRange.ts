/** antd DatePicker.RangePicker 的测试操作助手。
 * jsdom 里 RangePicker 的日期要「输入完整文本 + Enter」才提交（rc-picker 在
 * Enter 时解析并触发 onChange）；只 type 不 Enter 会停留在草稿态。
 * aria-label 会被复制到两个内部 input，须 getAllByLabelText 而非 getByLabelText。 */

import type { UserEvent } from "@testing-library/user-event";

/** 面板（或任意容器）内第一枚 RangePicker 的两个内部输入框。 */
function rangeInputs(pane: HTMLElement): [HTMLInputElement, HTMLInputElement] {
  const inputs = pane.querySelectorAll<HTMLInputElement>(".ant-picker-input input");
  if (inputs.length < 2) throw new Error("容器内未找到 RangePicker 的两个输入框");
  return [inputs[0]!, inputs[1]!];
}

/** 断言面板内 RangePicker 当前显示的起止日期（未选时为空串）。 */
export function antdRangeValues(pane: HTMLElement): [string, string] {
  const [start, end] = rangeInputs(pane);
  return [start.value, end.value];
}

/** 设置区间：清空两框后逐个输入并按 Enter 提交（from、to 都必填——合并控件不支持半区间）。 */
export async function setAntdDateRange(
  pane: HTMLElement,
  ui: UserEvent,
  from: string,
  to: string,
): Promise<void> {
  const [start, end] = rangeInputs(pane);
  await ui.clear(start);
  await ui.type(start, from);
  await ui.keyboard("{Enter}");
  await ui.clear(end);
  await ui.type(end, to);
  await ui.keyboard("{Enter}");
}
