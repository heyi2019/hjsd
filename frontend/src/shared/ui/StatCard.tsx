/** 指标卡：资金/经营概览的统一容器，金额一律以字符串传入。 */
import type { ReactNode } from "react";
import { MoneyText } from "./MoneyText";

/** 卡面语气：warn 只用于有风险但不是负数的场景。 */
export type StatTone = "plain" | "income" | "expense" | "warn";

export function StatCard(props: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: StatTone;
}) {
  return (
    <div className={`ui-stat ui-stat--${props.tone ?? "plain"}`}>
      <span className="ui-stat__label muted">{props.label}</span>
      <span className="ui-stat__value">{props.value}</span>
      {props.hint ? <span className="ui-stat__hint muted">{props.hint}</span> : null}
    </div>
  );
}

export function StatRow(props: {
  items: {
    label: string;
    /** 未传则显示 "-"。金额以字符串透传，此处不做任何加减。 */
    amount?: string | number | null;
    /** count=计数（整数原样显示）；money=金额（千分位两位小数）。默认按 amount 推断。 */
    kind?: "count" | "money";
    hint?: string;
    /** auto：按金额正负自动上色（中国区惯例：正红负绿）。 */
    tone?: StatTone | "auto";
  }[];
}) {
  return (
    <div className="ui-stat-row">
      {props.items.map((item) => {
        const kind = item.kind ?? (typeof item.amount === "number" ? "count" : "money");
        const isBlank = item.amount === undefined || item.amount === null;
        const value = isBlank ? (
          "-"
        ) : kind === "count" ? (
          String(item.amount)
        ) : (
          <MoneyText
            value={item.amount}
            tone={item.tone === "warn" ? "plain" : (item.tone ?? "plain")}
          />
        );
        return (
          <StatCard
            key={item.label}
            label={item.label}
            value={value}
            hint={item.hint}
            tone={item.tone === "auto" ? "plain" : item.tone}
          />
        );
      })}
    </div>
  );
}
