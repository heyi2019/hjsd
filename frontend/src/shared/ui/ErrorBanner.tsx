/** 错误条：按错误码给可执行的下一步，而不只是复述报错。 */
import { Alert } from "antd";
import type { NormalizedError } from "../api/client";

const HINTS: Record<string, string> = {
  AUTH_REQUIRED: "请先登录或选择开发用户。",
  TOKEN_EXPIRED: "登录已过期，请重新登录。",
  PERMISSION_DENIED: "当前角色无此权限，请联系管理员。",
  POOL_ROUTE_MISSING: "该业务尚未配置资金池路由，请到「设置 → 主数据」补路由。",
  POOL_DISABLED: "资金池已停用，请改用启用中的资金池。",
  CUSTOMER_DISABLED: "客户已停用，不能作为新订单参与方。",
  COUNTERPARTY_DISABLED: "合作方已停用，不能作为新订单参与方。",
  PAYMENT_EXCEEDS_RECEIVABLE: "金额超过可收/可结算上限，请核对后重填。",
  ORDER_STATUS_CONFLICT: "订单当前状态不允许该操作，请刷新详情。",
  VALIDATION_ERROR: "提交内容未通过校验，请检查必填项与格式。",
};

export function ErrorBanner(props: {
  /** 首选：normalizeError() 的对象，自动带 code 查 HINTS。 */
  error?: NormalizedError | string | null;
  /** 兼容：裸文案（页面自定义提示，无错误码）。 */
  message?: string | null;
  code?: string | null;
}) {
  // 兼容两种传法：normalizeError() 的对象，或裸字符串。
  const message =
    typeof props.error === "string" ? props.error : props.error?.message ?? props.message;
  const code = props.code ?? (typeof props.error === "object" ? props.error?.code : undefined);
  if (!message) return null;
  const hint = code ? HINTS[code] : undefined;
  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 12 }}
      message={message}
      description={hint}
    />
  );
}
