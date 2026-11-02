import { describe, expect, it } from "vitest";
import type { Account } from "../shared/api/catalog";
import { buildInventoryCsv } from "./inventory-export";

const account = {
  id: 1,
  source_order_no: "HS-2026-0001",
  stock_no: "KU_00001",
  business_mode: "SELF",
  inventory_type: "RECOVERY",
  game_type: "手游",
  game_account: "acc,1",
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
    expect(csv).toContain("订单号,业务,类型,游戏/产品类型,库存编号,平台,成本,库存状态");
    expect(csv).not.toContain(",详情");
    expect(csv).toContain('HS-2026-0001,自营,回收,手游,KU_00001,A平台,100.00,在库');
    expect(csv).toContain('"高段位\n账号"');
  });

  it("没有明细时保持明细字段为空而不阻断导出", () => {
    const csv = buildInventoryCsv([account]);
    expect(csv).toContain(",admin,-,-,-,-,-");
    expect(csv).toContain(",0,0,0.00,0.00");
  });

  it("FE-268：库存 CSV 使用详情订单号并把返点计入收入汇总", () => {
    const row = { ...account, source_order_no: "" } as unknown as Account;
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
            base_amount: "100.00",
            status: "OPEN",
            collected_on: "2026-11-02",
          }],
        }],
      } as never,
    });

    expect(csv).toContain("HS-FE268");
    expect(csv).toContain("买号返点 / HS-FE268 / HS-FE268-RB01 / 已登记 / 100.00");
    expect(csv).toContain(",0,1,0.00,100.00");
  });
});
