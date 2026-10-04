/** 错误条：按错误码给可执行的下一步，而不只是复述报错。 */
import { Alert } from "antd";

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
};

export function ErrorBanner(props: { message?: string | null; code?: string | null }) {
  if (!props.message) return null;
  const hint = props.code ? HINTS[props.code] : undefined;
  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 12 }}
      message={props.message}
      description={hint}
    />
  );
}
