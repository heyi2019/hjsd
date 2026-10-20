/** 容器内错误提示：用于 Modal / Drawer 内部。
 *
 * 背景：此前写操作失败只把错误写进页面级 state，而 ErrorBanner 渲染在页面顶层——
 * 一旦有 Modal 打开，错误条被遮罩挡住，用户看到的是「点了没反应」。
 * 凡是弹窗内的提交，必须把错误渲染在弹窗内部。
 */
import { Alert } from "antd";
import type { NormalizedError } from "../api/client";

export function InlineError(props: { error: NormalizedError | null | undefined; style?: React.CSSProperties }) {
  if (!props.error) return null;
  return (
    <Alert
      type="error"
      showIcon
      role="alert"
      message={props.error.message}
      style={{ marginBottom: 12, ...props.style }}
    />
  );
}
