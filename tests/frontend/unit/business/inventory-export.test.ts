import { describe, expect, it } from "vitest";
import type { Account } from "@/shared/api/types/accounts";
import { buildInventoryCsv } from "@/stocks/inventory-export";

const account = {
  id: 1,
  source_order_no: "HS-2026-0001",
  stock_no: "KU_00001",
  business_mode: "SELF",
  inventory_type: "RECOVERY",
  game_type: "手游",
  game_account: "acc,1",
  camp_account: "营地A",
  platform: "A平台",
  status: "WAITING",
  cost_amount: "100.00",
  created_by: "admin",
  account_description: "高段位\n账号",
  account_images: ["image-1"],
} as unknown as Account;

describe("库存导出", () => {
  it("输出通用库存字段并正确转义 CSV 内容", () => {
    const csv = buildInventoryCsv([account]);
    expect(csv).toContain("订单号,业务,类型,游戏/产品类型,营地账号,库存编号,平台,成本,库存状态");
    expect(csv).not.toContain(",详情");
    expect(csv).toContain('HS-2026-0001,自营,回收,手游,营地A,KU_00001,A平台,100.00,在库');
    expect(csv).toContain('"高段位\n账号"');
  });

  it("在手时间列直取后端天数，不按入库时间自行计算", () => {
    // inventory_entry_at 给 2020 年：若前端还在算日期差，会导出上千天。
    const csv = buildInventoryCsv([
      { ...account, inventory_entry_at: "2020-01-01T00:00:00", inventory_age_days: 12 } as unknown as Account,
      { ...account, id: 2, inventory_entry_at: "2020-01-01T00:00:00", inventory_age_days: null } as unknown as Account,
    ]);
    expect(csv).toContain(",12天,");
    // 非在库（后端不给天数）留空，不能写成 0天。
    expect(csv).not.toContain("0天");
  });

  it("没有明细时保持明细字段为空而不阻断导出", () => {
    const csv = buildInventoryCsv([account]);
    expect(csv).toContain(",admin,-,-,-,-,-");
    expect(csv).toContain(",0,0,0.00,0.00");
  });

  it("FE-268：库存 CSV 使用库存绑定订单号，合计取服务端 finance_summary", () => {
    const row = { ...account, source_order_no: "HS-FE268" } as unknown as Account;
    const csv = buildInventoryCsv([row], {
      1: {
        orders: [{
          order_id: 11,
          order_no: "HS-FE268",
          order_type: "HS",
          status: "DONE",
          created_at: "2026-11-02T10:00:00",
          events: [],
          rebates: [{
            id: 1,
            rebate_no: "HS-FE268-RB01",
            rebate_type: "BUY",
            channel: "买号返点",
            rate: "10",
            amount: "100.00",
            status: "OPEN",
            collected_on: "2026-11-02",
          }],
        }],
        detail_view: {
          execution_rows: [],
          finance_rows: [{
            key: "rebate-1",
            flow_no: "HS-FE268-RB01",
            type: "买号返点",
            direction: "收入",
            amount: "100.00",
            occurred_at: "2026-11-02T10:00:00",
            pool_name: "-",
            note: "",
            operator: "-",
          }],
          operation_rows: [],
          lifecycle: { removed_platform: "-", recovery_platform: "-", sale_platform: "-" },
          order_notes: "-",
          parties: [],
          extras: [],
        },
        finance_summary: {
          cashflow_income: "0.00",
          rebate_income: "100.00",
          total_income: "100.00",
          total_expense: "0.00",
          net_amount: "100.00",
        },
      } as never,
    });

    expect(csv).toContain("HS-FE268");
    expect(csv).toContain("买号返点 /  / rebate-1 / 收入 / 100.00 / 2026-11-02 10:00 / -");
    // 「支出笔数,收入笔数,总支出,总收入」：条数按明细数，金额只认后端。
    expect(csv).toContain(",0,1,0.00,100.00");
  });

  it("导出合计不与明细相加：金额以后端 finance_summary 为准", () => {
    // 故意让后端合计与明细口径不同（明细里有 500 收入），导出必须输出后端值。
    const csv = buildInventoryCsv([account], {
      1: {
        orders: [{
          order_id: 11,
          order_no: "HS-SUM",
          order_type: "HS",
          status: "DONE",
          created_at: "2026-11-02T10:00:00",
          events: [],
          cashflows: [{
            flow_no: "SR-SUM-01",
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
        detail_view: {
          execution_rows: [],
          finance_rows: [{
            key: "cashflow-income-1",
            flow_no: "SR-SUM-01",
            type: "附加收入",
            direction: "收入",
            amount: "500.00",
            occurred_at: "2026-11-02T10:00:00",
            pool_name: "未分配资金账户",
            note: "",
            operator: "admin",
          }],
          operation_rows: [],
          lifecycle: { removed_platform: "-", recovery_platform: "-", sale_platform: "-" },
          order_notes: "-",
          parties: [],
          extras: [],
        },
        finance_summary: {
          cashflow_income: "123.45",
          rebate_income: "0.00",
          total_income: "123.45",
          total_expense: "67.89",
          net_amount: "55.56",
        },
      } as never,
    });

    expect(csv).toContain(",0,1,67.89,123.45");
    expect(csv).not.toContain(",0,1,0.00,500.00");
  });

  it("FE-054：库存 CSV 不暴露账号密码", () => {
    const withPassword = { ...account, game_password: "secret-password" } as unknown as Account;
    const csv = buildInventoryCsv([withPassword]);
    expect(csv).not.toContain("账号密码");
    expect(csv).not.toContain("secret-password");
  });
});
