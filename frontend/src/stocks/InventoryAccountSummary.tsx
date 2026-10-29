import type { Account } from "../shared/api/catalog";
import "./InventoryAccountSummary.css";

/** 库存账号操作弹窗共用的左侧紧凑业务摘要。 */
export function InventoryAccountSummary(props: { account: Account | null }) {
  return <div className="inventory-account-summary" aria-label="账号操作摘要">
    <div><span>订单编号</span><strong>{props.account?.source_order_no ?? "提交后生成"}</strong></div>
    <div><span>游戏类型</span><strong>{props.account?.game_type ?? "未填写"}</strong></div>
    <div><span>游戏账号</span><strong>{props.account?.game_account ?? "未填写"}</strong></div>
  </div>;
}
