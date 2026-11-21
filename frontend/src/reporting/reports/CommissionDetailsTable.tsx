import type { CommissionOrderGroup, CommissionRow } from "../../shared/api/types/reporting";
import { MoneyText } from "../../shared/ui";
import "./CommissionReport.css";

export function CommissionDetailsTable({ row, personName }: { row: CommissionOrderGroup; personName?: (detail: CommissionRow) => string }) {
  const name = personName ?? ((detail: CommissionRow) => detail.user_id == null ? "公司" : detail.user_name || `人员${detail.user_id}`);
  return (
    <div className="ui-table-wrap commission-detail-container">
      <table className="commission-detail-table">
        <thead><tr><th>分润人员</th><th>分润基数</th><th>费率</th></tr></thead>
        <tbody>{row.orders.map((detail, index) => (
          <tr key={`${row.order_id}-${detail.user_id ?? "company"}-${index}`}>
            <td>{name(detail)}</td><td><MoneyText value={detail.profit_base} /></td><td>{detail.rate}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
