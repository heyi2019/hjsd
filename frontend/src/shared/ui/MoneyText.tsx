/** 金额展示：后端以字符串传 DECIMAL，前端只展示不做浮点运算。
 * 中国区惯例：涨/收入为正用红色，跌/支出为负用绿色。 */
import { money } from "../lib/format";

export function MoneyText(props: {
  value: string | number | null | undefined;
  /** 收支语义：支出/负数按中国区惯例显示绿色。 */
  tone?: "auto" | "plain" | "income" | "expense";
  strong?: boolean;
}) {
  const text = money(props.value);
  const numeric = Number(String(props.value ?? 0));
  let tone: "plain" | "income" | "expense" = "plain";
  if (props.tone === "auto") {
    tone = numeric < 0 ? "expense" : numeric > 0 ? "income" : "plain";
  } else if (props.tone) {
    tone = props.tone;
  }
  return (
    <span
      className={`ui-money ui-money--${tone}${props.strong ? " ui-money--strong" : ""}`}
    >
      {text}
    </span>
  );
}
