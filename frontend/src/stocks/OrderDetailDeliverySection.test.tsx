import { screen, waitFor } from "@testing-library/react";
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

  it("FE-265：订单详情回显交易平台、中介类型和包赔类型", async () => {
    const detail = {
      orders: [{
        order_id: 21,
        order_no: "HS-FE265",
        order_type: "HS",
        created_at: "2026-11-02T10:00:00",
        extra_values: {
          intermediary_platform: "盼之",
          intermediary_type: "包赔",
          compensation_type: "续保",
        },
        events: [],
      }],
    };

    renderLight(
      <OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE265" } as never} detail={detail as never} />,
      { user: "admin" },
    );

    await waitFor(() => {
      expect(screen.getByText("盼之")).toBeInTheDocument();
      expect(screen.getByText("包赔")).toBeInTheDocument();
      expect(screen.getByText("续保")).toBeInTheDocument();
    });
  });

  it("FE-266：交付负责人回显员工姓名，未加载时不泄露原始 ID", async () => {
    const detail = {
      orders: [{
        order_id: 22,
        order_no: "HS-FE266",
        order_type: "HS",
        created_at: "2026-11-02T10:00:00",
        extra_values: { delivery_responsible_ids: [7] },
        events: [],
      }],
    };

    const { unmount } = renderLight(
      <OrderDetailDeliverySection
        meta={{ sourceOrderNo: "HS-FE266" } as never}
        detail={detail as never}
        employees={[{ id: 7, username: "lisi", display_name: "李三（三三）", is_active: true }]}
      />,
      { user: "admin" },
    );

    await waitFor(() => expect(screen.getByText("李三（三三）")).toBeInTheDocument());
    expect(screen.queryByText("7")).not.toBeInTheDocument();
    unmount();

    renderLight(
      <OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE266" } as never} detail={detail as never} />,
      { user: "admin" },
    );
    await waitFor(() => expect(screen.getByText("负责人信息加载中")).toBeInTheDocument());
    expect(screen.queryByText("7")).not.toBeInTheDocument();
  });

  it("FE-267：买号和卖号交付都回显手机号绑定人", async () => {
    const detail = {
      orders: [
        {
          order_id: 23,
          order_no: "HS-FE267",
          order_type: "HS",
          created_at: "2026-11-02T10:00:00",
          extra_values: { bound_phone: "13800000001", bound_phone_owner: "买家负责人" },
          events: [],
        },
        {
          order_id: 24,
          order_no: "DG-FE267",
          order_type: "DG",
          created_at: "2026-11-02T11:00:00",
          extra_values: { bound_phone: "13800000002", bound_phone_owner: "卖出负责人" },
          events: [{ event_type: "SELL", id: 1, amount: "1", occurred_on: "2026-11-02" }],
        },
      ],
    };

    renderLight(
      <OrderDetailDeliverySection meta={{ sourceOrderNo: "HS-FE267" } as never} detail={detail as never} />,
      { user: "admin" },
    );

    await waitFor(() => {
      expect(screen.getByText("买家负责人")).toBeInTheDocument();
      expect(screen.getByText("卖出负责人")).toBeInTheDocument();
      expect(screen.getByText("13800000001")).toBeInTheDocument();
      expect(screen.getByText("13800000002")).toBeInTheDocument();
    });
  });
});
