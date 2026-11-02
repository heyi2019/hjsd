import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../test/render";
import { CustomersPage } from "./CustomersPage";
import * as catalog from "../shared/api/catalog";
import { seedOptionSets } from "../test/formFieldsSeed";

vi.mock("../shared/api/catalog");
vi.mock("./CustomerLeadPanel", () => ({ CustomerLeadPanel: () => <div /> }));

const customers = [
  { id: 1, customer_no: "CUS-0001", display_name: "张三", contact_name: "张", phone: "138", wechat: "z", qq: "1", status: "ACTIVE", note: "老客户", extra_values: {} },
];

beforeEach(() => {
  vi.clearAllMocks();
  seedOptionSets(catalog);
  vi.mocked(catalog.customersApi.list).mockResolvedValue(customers as unknown as never);
  vi.mocked(catalog.counterpartiesApi.list).mockResolvedValue([] as never);
  vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue([] as never);
});

describe("CustomersPage：响应式渲染", () => {
  it("窄屏（compact）渲染移动端客户列表", async () => {
    const matchMediaSpy = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: /max-width:\s*640px/.test(query),
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    renderLight(<CustomersPage />, { user: "admin" });
    expect(await screen.findByText(/CUS-0001/)).toBeInTheDocument();
    expect(document.querySelector(".customers-mobile-list")).toBeInTheDocument();
    matchMediaSpy.mockRestore();
  });
});
