import { describe, expect, it } from "vitest";
import type { Account } from "../shared/api/catalog";
import { buildInventoryCsv } from "./inventory-export";

const account = {
  id: 1,
  source_order_no: "HS-2026-0001",
  business_mode: "SELF",
  inventory_type: "RECOVERY",
  game_type: "手游",
  game_account: "acc,1",
  platform: "A平台",
  status: "IN_STOCK",
  cost_amount: "100.00",
  created_by: "admin",
  account_description: "高段位\n账号",
  account_images: ["image-1"],
} as unknown as Account;

describe("库存导出", () => {
  it("输出通用库存字段并正确转义 CSV 内容", () => {
    const csv = buildInventoryCsv([account]);
    expect(csv).toContain("订单号,业务,类型,产品,账号标识,平台,成本,库存状态");
    expect(csv).toContain('HS-2026-0001,自营,回收,手游,"acc,1",A平台,100.00,在库');
    expect(csv).toContain('"高段位\n账号"');
  });

  it("没有明细时保持明细字段为空而不阻断导出", () => {
    const csv = buildInventoryCsv([account]);
    expect(csv).toContain(",admin,-,-,-,-,-");
    expect(csv).toContain(",0,0,0.00,0.00");
  });
});
