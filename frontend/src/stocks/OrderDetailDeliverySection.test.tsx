import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../shared/api/catalog";
import { renderLight } from "../test/render";
import { OrderDetailDeliverySection } from "./OrderDetailDeliverySection";

vi.mock("../shared/api/catalog");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalog.orderFormFieldsApi.list).mockResolvedValue([]);
});

describe("OrderDetailDeliverySection", () => {
  it("交付明细每行展示 6 个字段", async () => {
    const detail = {
      orders: [{
        order_id: 21,
        order_no: "HS0001",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        form_extra: {
          bound_phone: "13800000000",
          bound_phone_owner: "买家",
          intermediary_platform: "盼之",
          intermediary_type: "普中",
          compensation_type: "首保",
          delivery_responsible_ids: [1],
        },
        extra_values: {
          bound_phone: "13800000000",
          bound_phone_owner: "买家",
          intermediary_platform: "盼之",
          intermediary_type: "普中",
          compensation_type: "首保",
          delivery_responsible_ids: [1],
        },
        events: [],
      }],
    };

    renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "HS0001" } as never}
        detail={detail as never}
        employees={[{ id: 1, username: "admin", display_name: "管理员", is_active: true }]}
      />,
      { user: "admin" },
    );

    await waitFor(() => {
      const table = document.querySelector(".inventory-detail__meta-table");
      expect(table).not.toBeNull();
      expect(table?.querySelectorAll("tbody > tr")).toHaveLength(1);
    });
  });
});
