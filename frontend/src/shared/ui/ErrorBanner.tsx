/** 错误条：按错误码给可执行的下一步，而不只是复述报错。 */
import { Alert, Button } from "antd";
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
  /** 页面统一传入 normalizeError() 产出的错误对象。 */
  error?: NormalizedError | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const message = props.error?.message;
  const code = props.error?.code;
  if (!message) return null;
  const hint = code ? HINTS[code] : undefined;
  const canRetry = Boolean(props.onRetry) && !["AUTH_REQUIRED", "TOKEN_EXPIRED", "PERMISSION_DENIED"].includes(code ?? "");
  return (
    <Alert
      className="ui-error-banner"
      type="error"
      showIcon
      role="alert"
      aria-live="assertive"
      message={message}
      description={hint}
      action={
        canRetry ? (
          <Button type="link" size="small" loading={props.retrying} onClick={props.onRetry}>
            重新加载
          </Button>
        ) : undefined
      }
    />
  );
}
