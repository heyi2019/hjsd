import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Account, AccountExecutionDetail } from "../shared/api/catalog";
import { InventoryDetail } from "./InventoryDetail";

const account = {
  id: 1,
  game_account: "acc-1",
  inventory_type: "RECOVERY",
  status: "IN_STOCK",
  created_by: "admin",
  created_at: "2026-10-01T09:30:00",
  account_description: "高段位账号",
  account_images: [],
  has_secondary: false,
  cost_amount: "100.00",
} as unknown as Account;

describe("InventoryDetail", () => {
  it("加载中没有明细时显示加载状态", () => {
    render(<InventoryDetail row={account} loading />);
    expect(document.querySelector(".ant-spin")).toBeTruthy();
  });

  it("按动作和资金明细展示操作人、方向与汇总", () => {
    const detail = {
      orders: [{
        order_id: 1,
        order_no: "HS0001",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        events: [{
          id: 1,
          event_no: "EV0001",
          event_type: "BUY",
          amount: "100.00",
          occurred_at: "2026-10-15T10:20:00",
          operator: "admin",
          note: "回收登记",
          cashflow: { flow_no: "CF0001", direction: "OUT", amount: "100.00" },
        }],
        rebates: [],
      }],
    } as unknown as AccountExecutionDetail;

    render(<InventoryDetail row={account} detail={detail} loading={false} />);
    const panel = document.querySelector(".inventory-detail") as HTMLElement;
    expect(within(panel).getByText("HS0001")).toBeInTheDocument();
    expect(within(panel).getByText("渠道 / 区服")).toBeInTheDocument();
    expect(within(panel).getByText("流转记录")).toBeInTheDocument();
    expect(within(panel).getByText("操作记录")).toBeInTheDocument();
    expect(within(panel).getAllByText("admin").length).toBeGreaterThanOrEqual(2);
    expect(within(panel).getAllByText("100.00").length).toBeGreaterThanOrEqual(2);
    expect(within(panel).getByText("买号本金")).toBeInTheDocument();
    expect(within(panel).getByText("总支出")).toBeInTheDocument();
  });

  it("参与方按角色与名称展示，并可打开客户中心卡片", () => {
    const onPartyClick = vi.fn();
    const detail = {
      orders: [{
        order_id: 1,
        order_no: "HS0001",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        customers: [
          { id: 7, display_name: "买家A", role: "BUYER" },
          { id: 8, display_name: "卖家B", role: "SELLER" },
        ],
        counterparties: [{ id: 11, display_name: "平台A", role: "PLATFORM" }],
        events: [],
      }],
    } as unknown as AccountExecutionDetail;

    render(<InventoryDetail row={account} detail={detail} loading={false} onPartyClick={onPartyClick} />);

    const buyer = screen.getByRole("link", { name: "客户_买家：买家A" });
    expect(screen.getByRole("link", { name: "客户_卖家：卖家B" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "合作方_平台：平台A" })).toBeInTheDocument();
    fireEvent.click(buyer);
    expect(onPartyClick).toHaveBeenCalledWith({ id: 7, display_name: "买家A", role: "BUYER", entityType: "customer" });
  });

  it("把展开详情按基础信息、执行明细和资金明细分成独立视觉层", () => {
    render(<InventoryDetail row={account} detail={{ orders: [] } as unknown as AccountExecutionDetail} loading={false} />);
    const panel = document.querySelector(".inventory-detail") as HTMLElement;
    expect(within(panel).getByText("账号 / 产品信息")).toBeInTheDocument();
    expect(within(panel).getByText("登记与流转信息")).toBeInTheDocument();
    expect(within(panel).queryByText("其他补充信息")).toBeNull();
    expect(within(panel).queryByText("订单扩展字段")).toBeNull();
    expect(within(panel).getByText("账号补充资料")).toBeInTheDocument();
    expect(panel.querySelector(".inventory-detail__meta")).toBeTruthy();
    expect(panel.querySelector(".inventory-detail__section--execution")).toBeTruthy();
    expect(panel.querySelector(".inventory-detail__section--finance")).toBeTruthy();
    expect(panel.querySelector(".inventory-finance-summary__item--amount")).toBeTruthy();
  });

  it("给展开表格中的信息表保留独立留白", () => {
    render(<InventoryDetail row={account} detail={{ orders: [] } as unknown as AccountExecutionDetail} loading={false} />);
    const panel = document.querySelector(".inventory-detail") as HTMLElement;
    expect(panel.querySelector(".inventory-detail__meta-table")).toBeTruthy();
  });

  it("其他补充信息按左标签右内容单列展示", () => {
    const detail = {
      orders: [{
        order_id: 1,
        order_no: "HS0001",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        note: "订单备注内容",
        extra_values: { source_note: "来源说明" },
        events: [],
      }],
    } as unknown as AccountExecutionDetail;
    render(<InventoryDetail row={account} detail={detail} loading={false} />);
    const table = document.querySelector(".inventory-detail__order-supplement");
    expect(table).toBeTruthy();
    expect(table?.querySelectorAll("tbody > tr")).toHaveLength(2);
  });

  it("在桌面详情中让描述、图片、备注各占整行", () => {
    render(<InventoryDetail row={account} detail={{ orders: [] } as unknown as AccountExecutionDetail} loading={false} />);
    for (const label of ["账号描述", "账号图片", "备注"]) {
      const node = screen.getByText(label);
      const row = node.closest("tr") ?? node.parentElement?.parentElement;
      expect(row).toBeTruthy();
      expect(row?.textContent ?? "").not.toContain("有无二次");
    }
  });

  it("编辑执行明细时操作员选择器保持可读宽度", () => {
    const detail = {
      orders: [{
        order_id: 1,
        order_no: "HS0001",
        order_type: "HS",
        created_at: "2026-10-15T10:19:00",
        events: [{
          id: 1,
          event_no: "EV0001",
          event_type: "BUY",
          amount: "100.00",
          occurred_at: "2026-10-15T10:20:00",
          operator: "admin",
          operator_user_ids: [7],
          note: "回收登记",
          cashflow: { flow_no: "CF0001", direction: "OUT", amount: "100.00" },
        }],
        rebates: [],
      }],
    } as unknown as AccountExecutionDetail;

    render(<InventoryDetail row={account} detail={detail} loading={false} editing={account} employees={[{ id: 7, username: "zhangsan", display_name: "张三", is_active: true }]} />);
    expect(document.querySelector(".inventory-edit-operator")).toBeTruthy();
  });
});
