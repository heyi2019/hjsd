import { MoneyText } from "../../../../shared/ui";

export function FinanceTotal({ amount }: { amount: string }) {
  return (
    <div className="finance-total">
      <span>支出合计</span>
      <MoneyText value={amount} strong />
    </div>
  );
}
