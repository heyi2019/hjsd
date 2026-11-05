import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Account, AccountExecutionDetail } from "@/shared/api/catalog";
import { OrderDetail } from "@/stocks/OrderDetail";
import { renderApp } from "@fixtures/render";

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
    expect(within(panel).getByText("总支出")).toBeInTheDocument();
  });

  it("FE-054：原详情测试入口不展示账号密码明文", () => {
    const accountWithPassword = { ...account, game_password: "secret-password", game_type: "原神" } as unknown as Account;
    render(<OrderDetail row={accountWithPassword} detail={{ orders: [] } as unknown as AccountExecutionDetail} loading={false} />);
    const panel = document.querySelector(".inventory-detail") as HTMLElement;
    expect(within(panel).queryByText("secret-password")).not.toBeInTheDocument();
    expect(within(panel).getByText("已隐藏")).toBeInTheDocument();
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

  it("把展开详情按基础信息、执行明细和资金明细分成独立视觉层", () => {
    render(<OrderDetail row={account} detail={{ orders: [] } as unknown as AccountExecutionDetail} loading={false} />);
    const panel = document.querySelector(".inventory-detail") as HTMLElement;
    // 已移除的冗余分组不应再出现
    expect(within(panel).queryByText("登记与流转信息")).toBeNull();
    expect(within(panel).queryByText("其他补充信息")).toBeNull();
    expect(within(panel).queryByText("主订单信息")).toBeNull();
    // 账号补充资料（描述 / 作图）现置于运营信息板块
    expect(within(panel).getByText("账号补充资料")).toBeInTheDocument();
    expect(within(panel).getByText("描述")).toBeInTheDocument();
    expect(within(panel).getByText("作图")).toBeInTheDocument();
    expect(panel.querySelector(".inventory-detail__meta")).toBeTruthy();
    expect(panel.querySelector(".inventory-detail__section--execution")).toBeTruthy();
    expect(panel.querySelector(".inventory-detail__section--finance")).toBeTruthy();
    expect(panel.querySelector(".inventory-finance-summary__item--amount")).toBeTruthy();
  });

  it("给展开表格中的信息表保留独立留白", () => {
    render(<OrderDetail row={account} detail={{ orders: [] } as unknown as AccountExecutionDetail} loading={false} />);
    const panel = document.querySelector(".inventory-detail") as HTMLElement;
    expect(panel.querySelector(".inventory-detail__meta-table")).toBeTruthy();
    const accountTable = panel.querySelector(".inventory-detail__section--profile .inventory-detail__meta-table");
    // 账号资料 7 项（游戏类型/账号/密码/区服/有无二次/钱包实名/账号备注）分 2 行网格。
    expect(accountTable?.querySelectorAll("tbody > tr")).toHaveLength(2);
  });

  it("账号补充资料（标签 描述/作图）置于运营信息，游戏账号信息不再含该组", () => {
    render(<OrderDetail row={account} detail={{ orders: [] } as unknown as AccountExecutionDetail} loading={false} />);
    const profileSection = document.querySelector(".inventory-detail__section--profile") as HTMLElement;
    const operationSection = document.querySelector(".inventory-detail__section--operation") as HTMLElement;
    // 游戏账号信息不再包含账号补充资料
    expect(profileSection.textContent).not.toContain("账号补充资料");
    // 账号补充资料组位于运营信息，标签为「描述 / 作图」，不再使用旧名「账号描述 / 账号图片」
    const groups = Array.from(operationSection.querySelectorAll(".inventory-detail__meta-group"));
    const supplementGroup = groups.find((g) => g.textContent?.includes("账号补充资料")) as HTMLElement;
    expect(supplementGroup.textContent).toContain("描述");
    expect(supplementGroup.textContent).toContain("作图");
    expect(supplementGroup.textContent).not.toContain("账号描述");
    expect(supplementGroup.textContent).not.toContain("账号图片");
    expect(supplementGroup.textContent).not.toContain("有无二次");
    // 游戏账号信息（走建单）：账号资料组含 有无二次 与 账号备注
    const accountGroup = Array.from(profileSection.querySelectorAll(".inventory-detail__meta-group"))
      .find((g) => g.textContent?.includes("账号资料") && !g.textContent?.includes("补充")) as HTMLElement;
    expect(accountGroup.textContent).toContain("有无二次");
    expect(accountGroup.textContent).toContain("账号备注");
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

    renderApp(<OrderDetail row={account} detail={detail} loading={false} editing={account} employees={[{ id: 7, username: "zhangsan", display_name: "张三", is_active: true }]} />);
    expect(document.querySelector(".inventory-edit-operator")).toBeTruthy();
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
          nature: "BUSINESS_IN",
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
    expect(within(summary).getByText("总支出").parentElement).toHaveTextContent("67.89");
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
