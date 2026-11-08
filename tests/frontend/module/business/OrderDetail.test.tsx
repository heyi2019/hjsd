import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLight } from "@fixtures/render";
import type { Account, AccountExecutionDetail } from "@/shared/api/catalog";
import { OrderDetail } from "@/orders/orderedit/OrderDetail";

const account = {
  id: 1,
  game_account: "acc-1",
  inventory_type: "RECOVERY",
  status: "WAITING",
  created_by: "admin",
  created_at: "2026-10-01T09:30:00",
  account_description: "高段位账号",
  account_images: [],
  has_secondary: false,
  cost_amount: "100.00",
} as unknown as Account;

describe("OrderDetail", () => {
  it("加载中没有明细时显示加载状态", () => {
    render(<OrderDetail row={account} loading />);
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

    render(<OrderDetail row={account} detail={detail} loading={false} />);
    const panel = document.querySelector(".inventory-detail") as HTMLElement;
    expect(within(panel).getByText("渠道 / 区服")).toBeInTheDocument();
    // 第一部分为竖向堆叠的多个板块：游戏账号信息为板块内标题。
    expect(within(panel).getAllByText("游戏账号信息").length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getByText("操作明细")).toBeInTheDocument();
    // 资金明细与操作明细均含「操作人」列，合并校验至少出现一次。
    expect(within(panel).getAllByText("操作人").length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getAllByText("admin").length).toBeGreaterThanOrEqual(2);
    expect(within(panel).getAllByText("100.00").length).toBeGreaterThanOrEqual(2);
    expect(within(panel).getByText("买号本金")).toBeInTheDocument();
    expect(within(panel).getByText("总支出（含坏账）")).toBeInTheDocument();
  });

  it("FE-054：原详情测试入口不展示账号密码明文", () => {
    const accountWithPassword = { ...account, game_password: "secret-password", game_type: "原神" } as unknown as Account;
    render(<OrderDetail row={accountWithPassword} detail={{ orders: [] } as unknown as AccountExecutionDetail} loading={false} />);
    const panel = document.querySelector(".inventory-detail") as HTMLElement;
    expect(within(panel).queryByText("secret-password")).not.toBeInTheDocument();
    expect(within(panel).getByText("已隐藏")).toBeInTheDocument();
  });

  it("全量编辑：详情各板块不保留只读字段", () => {
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
          cashflow: { flow_no: "CF0001", direction: "OUT", amount: "100.00", occurred_at: "2026-10-15T10:21:00", operator: "admin" },
        }],
        customers: [{ id: 7, display_name: "买家A", role: "BUYER" }],
      }],
      finance_summary: { total_income: "0.00", total_expense: "100.00", net_amount: "-100.00" },
    } as unknown as AccountExecutionDetail;

    renderLight(<OrderDetail row={{ ...account, bound_phone: "13800000000" } as unknown as Account} detail={detail} loading={false} editing={{ ...account, bound_phone: "13800000000" } as unknown as Account} />, { user: "admin" });

    const editPanel = screen.getByTestId("order-edit-feature-panel");
    expect(editPanel).toHaveAttribute("aria-label", "订单编辑功能板块");
    expect(editPanel).toHaveClass("inventory-detail");
    expect(editPanel).not.toHaveClass("inventory-detail--editing");
    expect(editPanel.querySelector(".inventory-detail__edit-grid")).not.toBeInTheDocument();
    expect(editPanel.querySelectorAll(".inventory-detail__meta").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("编辑登记时间")).toBeInTheDocument();
    expect(screen.getByLabelText("编辑售出时间")).toBeInTheDocument();
    expect(screen.getByLabelText("编辑流水时间 CF0001")).toBeInTheDocument();
    expect(screen.getByLabelText("编辑换绑手机号")).toBeInTheDocument();
    expect(screen.getByLabelText("编辑交易平台")).toBeInTheDocument();
    expect(screen.getByLabelText("编辑执行时间 买号")).toBeInTheDocument();
    expect(screen.getByLabelText("编辑资金金额 CF0001")).toBeInTheDocument();
    expect(screen.getByLabelText("编辑参与方 买家A")).toBeInTheDocument();
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

    render(<OrderDetail row={account} detail={detail} loading={false} onPartyClick={onPartyClick} />);

    const buyer = screen.getByRole("link", { name: "客户_买家：买家A" });
    expect(screen.getByRole("link", { name: "客户_卖家：卖家B" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "合作方_平台：平台A" })).toBeInTheDocument();
    fireEvent.click(buyer);
    expect(onPartyClick).toHaveBeenCalledWith({ id: 7, display_name: "买家A", role: "BUYER", entityType: "customer" });
  });

  it("FE-256：系统下架审计记录在账号详情中可追溯", () => {
    const detail = {
      orders: [],
      audit: [{
        id: 901,
        action: "ORDER_CANCEL",
        entity_type: "order",
        entity_id: "DG-88",
        actor: "admin",
        reason: "系统下架同步取消寄售平台上架",
        occurred_at: "2026-11-02T10:20:00",
      }],
    } as unknown as AccountExecutionDetail;

    render(<OrderDetail row={account} detail={detail} loading={false} />);

    expect(screen.getByText("操作追溯")).toBeInTheDocument();
    expect(screen.getByText("取消")).toBeInTheDocument();
    expect(screen.getByText("系统下架同步取消寄售平台上架")).toBeInTheDocument();
  });

  it("FE-269：返点进入收入笔数，总收入取服务端 finance_summary", () => {
    const detail = {
      orders: [{
        order_id: 269,
        order_no: "HS-FE269",
        order_type: "HS",
        status: "DONE",
        created_at: "2026-11-02T10:00:00",
        events: [],
        rebates: [{
          id: 1,
          rebate_no: "HS-FE269-RB01",
          rebate_type: "BUY",
          channel: "买号返点",
          rate: "10",
          base_amount: "100.00",
          status: "OPEN",
          collected_on: "2026-11-02",
        }],
      }],
      finance_summary: {
        cashflow_income: "0.00",
        rebate_income: "100.00",
        total_income: "100.00",
        total_expense: "0.00",
        net_amount: "100.00",
      },
    } as unknown as AccountExecutionDetail;

    render(<OrderDetail row={account} detail={detail} loading={false} />);
    const panel = document.querySelector(".inventory-detail") as HTMLElement;
    const finance = panel.querySelector(".inventory-detail__section--finance") as HTMLElement;
    expect(within(finance).getAllByText("1 笔").length).toBeGreaterThanOrEqual(1);
    const summary = finance.querySelector(".inventory-finance-summary") as HTMLElement;
    expect(within(summary).getByText("总收入").parentElement).toHaveTextContent("100.00");
  });

  it("总额度只认后端 finance_summary，不按明细行相加", () => {
    // 明细里有一笔 500.00 收入，但后端合计是 123.45：卡片必须显示 123.45。
    const detail = {
      orders: [{
        order_id: 271,
        order_no: "HS-FE271",
        order_type: "HS",
        status: "DONE",
        created_at: "2026-11-02T10:00:00",
        events: [],
        cashflows: [{
          flow_no: "SR-FE271",
          occurred_on: "2026-11-02",
          occurred_at: "2026-11-02T10:00:00",
          direction: "IN",
          category: "OTHER",
          amount: "500.00",
          operator: "admin",
        }],
        rebates: [],
      }],
      finance_summary: {
        cashflow_income: "123.45",
        rebate_income: "0.00",
        total_income: "123.45",
        total_expense: "67.89",
        net_amount: "55.56",
      },
    } as unknown as AccountExecutionDetail;

    render(<OrderDetail row={account} detail={detail} loading={false} />);
    const panel = document.querySelector(".inventory-detail") as HTMLElement;
    const summary = panel.querySelector(".inventory-finance-summary") as HTMLElement;
    expect(within(summary).getByText("总收入").parentElement).toHaveTextContent("123.45");
    expect(within(summary).getByText("总支出（含坏账）").parentElement).toHaveTextContent("67.89");
  });

  it("区分资金流水支出与含坏账的总支出", () => {
    const detail = {
      orders: [{
        order_id: 272,
        order_no: "HS-FE272",
        order_type: "HS",
        status: "DONE",
        created_at: "2026-11-02T10:00:00",
        events: [],
        rebates: [],
      }],
      finance_summary: {
        cashflow_income: "0.00",
        rebate_income: "0.00",
        total_income: "0.00",
        total_expense: "100.00",
        net_amount: "-100.00",
      },
    } as unknown as AccountExecutionDetail;

    render(<OrderDetail row={account} detail={detail} loading={false} />);
    const finance = document.querySelector(".inventory-detail__section--finance") as HTMLElement;
    expect(within(finance).getByText("资金流水支出")).toBeInTheDocument();
    expect(within(finance).getByText("总支出（含坏账）")).toBeInTheDocument();
    expect(within(finance).getByText("总支出含分期坏账，坏账不生成资金流水行")).toBeInTheDocument();
  });

  it("FE-129：无寄售平台的初始代挂单不应显示为已上架", () => {
    const consignmentAccount = { ...account, inventory_type: "CONSIGNMENT" } as unknown as Account;
    const detail = {
      orders: [{
        order_id: 129,
        order_no: "DG-FE129-BASE",
        order_type: "DG",
        status: "ACTIVE",
        created_at: "2026-11-02T10:00:00",
        trade_date: "2026-11-02",
        events: [],
        extra_values: {},
      }],
    } as unknown as AccountExecutionDetail;

    render(<OrderDetail row={consignmentAccount} detail={detail} loading={false} />);

    const operation = document.querySelector(".inventory-detail__section--operation") as HTMLElement;
    expect(within(operation).getByText("待售")).toBeInTheDocument();
    expect(within(operation).queryByText("寄售中")).toBeNull();
    expect(within(operation).queryByText("寄售平台 / 寄售时间")).toBeNull();
  });

  it("FE-129：明确平台的代挂动作才显示寄售中和平台时间", () => {
    const consignmentAccount = { ...account, inventory_type: "CONSIGNMENT" } as unknown as Account;
    const detail = {
      orders: [{
        order_id: 130,
        order_no: "DG-FE129-LISTED",
        order_type: "DG",
        status: "ACTIVE",
        created_at: "2026-11-02T10:00:00",
        trade_date: "2026-11-02",
        events: [],
        extra_values: { consignment_platform: "盼之", listed_at: "2026-11-02T10:05" },
      }],
    } as unknown as AccountExecutionDetail;

    render(<OrderDetail row={consignmentAccount} detail={detail} loading={false} />);

    const operation = document.querySelector(".inventory-detail__section--operation") as HTMLElement;
    expect(within(operation).getByText("寄售中")).toBeInTheDocument();
    expect(within(operation).getByText("盼之 / 2026-11-02 10:05")).toBeInTheDocument();
  });
});
