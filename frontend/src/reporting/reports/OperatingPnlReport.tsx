/** OperatingPnl：将月度趋势与业务拆分合并到同一个经营损益 Tab。 */

import { MonthlyPnl } from "./MonthlyPnlReport";
import { BusinessPnl } from "./BusinessPnlReport";
import type { ReportRange } from "./shared";

export function OperatingPnl({ range }: { range: ReportRange }) {
  return (
    <div className="ui-stack">
      <MonthlyPnl range={range} />
      <BusinessPnl range={range} showPicker={false} />
    </div>
  );
}
