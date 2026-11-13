import dayjs from "dayjs";
import { Typography } from "antd";
import { DateField } from "../../shared/ui";

type OrderDetailTimeShiftSectionProps = {
  registeredAt: string;
  soldAt: string;
  flowAt: string;
  shiftMinutes: number;
  onShift: (minutes: number) => void;
};

function TimeShiftField({
  label,
  original,
  shiftMinutes,
  onShift,
}: {
  label: string;
  original: string;
  shiftMinutes: number;
  onShift: (minutes: number) => void;
}) {
  const base = original === "-" ? "" : original;
  const shown = base ? dayjs(base).add(shiftMinutes, "minute").format("YYYY-MM-DD HH:mm") : "";
  return (
    <label className="inventory-time-shift__field">
      <span>{label}</span>
      <DateField
        showTime={{ format: "HH:mm" }}
        format="YYYY-MM-DD HH:mm"
        minuteStep={1}
        aria-label={`编辑${label}`}
        disabled={!base}
        value={shown ? dayjs(shown) : null}
        onChange={(value) => onShift(value && base ? value.diff(dayjs(base), "minute") : 0)}
      />
    </label>
  );
}

export function OrderDetailTimeShiftSection({
  registeredAt,
  soldAt,
  flowAt,
  shiftMinutes,
  onShift,
}: OrderDetailTimeShiftSectionProps) {
  return (
    <div className="inventory-detail__section inventory-time-shift">
      <div className="inventory-detail__section-heading">
        <Typography.Text strong>时间联动</Typography.Text>
        <Typography.Text type="secondary">
          {shiftMinutes === 0
            ? "改任一项，本单订单、事件与资金流水时间同步平移，分期还款计划不变"
            : `整单时间轴平移 ${shiftMinutes} 分钟，分期还款计划不变`}
        </Typography.Text>
      </div>
      <div className="inventory-time-shift__fields">
        <TimeShiftField label="订单创建时间" original={registeredAt} shiftMinutes={shiftMinutes} onShift={onShift} />
        <TimeShiftField label="售出时间" original={soldAt} shiftMinutes={shiftMinutes} onShift={onShift} />
        <TimeShiftField label="流水时间" original={flowAt} shiftMinutes={shiftMinutes} onShift={onShift} />
      </div>
    </div>
  );
}
