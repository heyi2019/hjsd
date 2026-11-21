import { createContext, type ReactNode } from "react";
import { screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import { CreateBusinessModal } from "@/business/shared/order-create/CreateBusinessModal";
import { gameTypesApi } from "@/shared/api/misc.api";
import { orderFormFieldsApi } from "@/shared/api/orders.api";
import { employeesApi } from "@/shared/api/org.api";
import { poolsApi } from "@/shared/api/pools.api";

vi.mock("@/shared/api/misc.api");
vi.mock("@/shared/api/orders.api");
vi.mock("@/shared/api/org.api");
vi.mock("@/shared/api/pools.api");

vi.mock("@/business/ConfigurableField", () => ({
  FieldConfigContext: createContext({}),
  SectionLabelsContext: createContext({}),
  CustomFieldSection: () => null,
  FieldConfigStatus: () => null,
  useOrderFormConfig: () => ({ config: {} }),
  useOrderFormSectionLabels: () => ({ labels: {} }),
}));

vi.mock("@/business/shared/order-create/recovery/RecoveryAccountSection", () => ({
  RecoveryAccountSection: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/business/recovery/RecoveryCustomerSection", () => ({
  RecoveryCustomerSection: () => null,
}));
vi.mock("@/business/shared/order-create/recovery/RecoveryFeeSection", () => ({
  RecoveryFeeSection: () => null,
}));
vi.mock("@/business/shared/order-create/th/ThOrderSection", () => ({ ThOrderSection: () => null }));
vi.mock("@/business/shared/order-create/dg/DgOrderSection", () => ({ DgOrderSection: () => null }));

vi.mock("@/shared/ui", async () => {
  const actual = await vi.importActual<typeof import("@/shared/ui")>("@/shared/ui");
  return {
    ...actual,
    BusinessActionModal: ({ children }: { children?: ReactNode }) => <div data-testid="business-action-modal">{children}</div>,
    BusinessRegistrationForm: ({ children }: { children?: ReactNode }) => <div data-testid="business-order-form">{children}</div>,
    ConfirmDialog: () => null,
    ErrorBanner: () => null,
    PermissionButton: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  const pending = () => new Promise<never>(() => undefined);
  vi.mocked(gameTypesApi.list).mockImplementation(pending);
  vi.mocked(orderFormFieldsApi.list).mockImplementation(pending);
  vi.mocked(orderFormFieldsApi.listSectionLabels).mockImplementation(pending);
  vi.mocked(employeesApi.list).mockImplementation(pending);
  vi.mocked(poolsApi.list).mockImplementation(pending);
});

it("关闭建单弹窗时不组装完整建单表单", () => {
  renderLight(
    <CreateBusinessModal
      open={false}
      onClose={() => undefined}
      onCreated={() => undefined}
      initialOrderType="HS"
    />,
    { user: "admin" },
  );

  expect(screen.queryByTestId("business-order-form")).not.toBeInTheDocument();
  expect(screen.queryByTestId("business-action-modal")).not.toBeInTheDocument();
});
