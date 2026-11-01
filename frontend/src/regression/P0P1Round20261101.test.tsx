import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import * as catalog from "../shared/api/catalog";
import { CreateBusinessModal } from "../orders/CreateBusinessModal";
import { InstallmentsPanel } from "../installments/InstallmentsPanel";
import { clearOptionSetsCache, loadOptionSets } from "../shared/lib/optionSets";
import { seedOrderFormFields } from "../test/formFieldsSeed";

vi.mock("../shared/api/catalog");

const types = [{ id: 1, code: "TH", name: "提号", capital_type: "DISTRIBUTION", is_active: true }];
const settledInstallment = {
  id: 1,
  inst_no: "TH0002-FQ",
  contract_type: "STOCK_SALE",
  order_id: 10,
  down_payment: "100.00",
  principal: "300.00",
  service_fee: "0.00",
  per_period_service_fee: "0.00",
  per_period: "50.00",
  periods: 4,
  paid_amount: "300.00",
  total_receivable: "300.00",
  status: "SETTLED",
};

beforeEach(() => {
  vi.clearAllMocks();
  clearOptionSetsCache();
  seedOrderFormFields(catalog);
  vi.mocked(catalog.orderTypesApi.list).mockResolvedValue(types);
  vi.mocked(catalog.customersApi.list).mockResolvedValue([]);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.poolsApi.list).mockResolvedValue([]);
  vi.mocked(catalog.employeesApi.list).mockResolvedValue([]);
  vi.mocked(catalog.gameTypesApi.list).mockResolvedValue([
    { id: 1, name: "王者荣耀", sort_order: 10, is_active: true, is_default: true },
  ]);
  vi.mocked(catalog.optionSetsApi.list).mockResolvedValue({
    items: [{
      code: "SUPPLIER_SOURCE",
      options: [
        { value: "自营", label: "自营" },
        { value: "其他", label: "其他" },
      ],
    }],
  } as never);
  vi.mocked(catalog.installmentsApi.list).mockResolvedValue([settledInstallment]);
  vi.mocked(catalog.installmentsApi.schedules).mockResolvedValue([
    { id: 1, installment_id: 1, period_no: 0, due_on: "2026-10-01", due_amount: "100.00", received_amount: "100.00", status: "PAID" },
  ]);
  vi.mocked(catalog.installmentsApi.dispositions).mockResolvedValue([]);
  vi.mocked(catalog.ordersApi.list).mockResolvedValue([
    { id: 10, order_no: "TH-2026-0002", order_type: "TH", capital_type: "DISTRIBUTION", trade_date: "2026-10-01", status: "ACTIVE" },
  ]);
});

afterEach(() => {
  clearOptionSetsCache();
});

it("FE-123：提号供货方来源默认值必须来自当前主数据选项", async () => {
  await loadOptionSets();
  renderLight(
    <CreateBusinessModal
      open
      onClose={() => undefined}
      onCreated={() => undefined}
      initialOrderType="TH"
    />,
    { user: "admin" },
  );

  const field = await screen.findByLabelText("供货方来源");
  await waitFor(() => expect(catalog.optionSetsApi.list).toHaveBeenCalled());
  await waitFor(() => {
    expect(field.closest(".ant-select")?.querySelector(".ant-select-selection-item")).toHaveTextContent("自营");
  });
});

it("P0/FE-074：已结清合约禁止登记收款和终止退款", async () => {
  renderLight(<InstallmentsPanel />, { user: "admin" });
  await screen.findByText("TH0002-FQ");
  expect(screen.getByRole("button", { name: /登记收款/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /终止分期并退款/ })).toBeDisabled();
});
