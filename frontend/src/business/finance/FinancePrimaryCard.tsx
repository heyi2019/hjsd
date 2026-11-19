import type { ReactNode } from "react";
import { BusinessRegistrationGroup } from "../../shared/ui";
import { FinanceExpenseItems } from "./FinanceExpenseItems";

export function FinancePrimaryCard({ children }: { children: ReactNode }) {
  return (
    <BusinessRegistrationGroup
      className="primary-amount-fields finance-card-with-expense-action finance-card-with-expense-action--reserved"
    >
      {children}
      <FinanceExpenseItems className="finance-expense-items--embedded" />
    </BusinessRegistrationGroup>
  );
}
